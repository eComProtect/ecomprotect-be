import { Request, Response, NextFunction } from "express";
import { auth } from "@/lib/auth";
import { shopify } from "@/configs/shopify.config";
import { users } from "@/schema/schema";
import { database } from "@/configs/connection.config";
import { eq, or, and, isNull } from "drizzle-orm";
import status from "http-status";

type User = typeof users.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      user?: User;
      apiClient?: { id: string; role: string };
    }
  }
}

const findUserByApiKey = async (apiKey: string): Promise<User | null> => {
  const user = await database
    .select()
    .from(users)
    .where(eq(users.shopify_api_key, apiKey));
  return user[0] || null;
};

const findUserByAccessToken = async (
  accessToken: string
): Promise<User | null> => {
  const userRecord = await database
    .select()
    .from(users)
    .where(eq(users.shopify_access_token, accessToken));

  return userRecord[0] || null;
};

export const findUserByShopDomain = async (
  shopDomain: string
): Promise<User | null> => {
  // Staff rows copy the owner's shopify_url verbatim, so more than one row can
  // share it — storeOwnerId IS NULL is what actually identifies the owner row
  // (see resolveStoreRow / findStoreOwnerByShopDomain in onboarding.controller.ts).
  // Without this filter, an App Bridge session token could resolve to whichever
  // staff row Postgres happens to return first instead of the real owner.
  const userRecord = await database
    .select()
    .from(users)
    .where(
      and(
        or(
          eq(users.shopify_url, `https://${shopDomain}`),
          eq(users.shopify_url, shopDomain)
        ),
        isNull(users.storeOwnerId)
      )
    );

  return userRecord[0] || null;
};

/**
 * A store's billing/onboarding state always lives on its owner row
 * (storeOwnerId IS NULL). Staff rows point at their owner via storeOwnerId,
 * so this resolves whichever row actually holds that shared state.
 */
export const resolveStoreRow = async (user: User): Promise<User | null> => {
  if (!user.storeOwnerId) {
    return user;
  }

  const [owner] = await database
    .select()
    .from(users)
    .where(eq(users.id, user.storeOwnerId));

  return owner || null;
};

/**
 * Resolves the store/user from a Shopify App Bridge session token (a short-lived JWT
 * sent by the embedded frontend). Embedded apps cannot rely on third-party cookies
 * inside the Admin iframe, so this is the primary auth path for merchants.
 *
 * decodeSessionToken verifies the JWT signature against SHOPIFY_API_SECRET and checks
 * expiry; its `dest` claim is the shop origin, e.g. "https://storename.myshopify.com".
 */
const findUserBySessionToken = async (token: string): Promise<User | null> => {
  try {
    const payload = await shopify.session.decodeSessionToken(token);
    const dest = payload.dest; // e.g. "https://storename.myshopify.com"
    const shopDomain = dest.replace(/^https?:\/\//, "");

    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shopDomain)) {
      return null;
    }

    return await findUserByShopDomain(shopDomain);
  } catch {
    // Not a valid Shopify session token (expired, tampered, or a different bearer
    // scheme). Fall through to the other auth strategies.
    return null;
  }
};

/**
 * Same identity resolution protectRoute uses (App Bridge session token, raw
 * Shopify access token, API key, then a better-auth cookie session), but
 * returns null on failure instead of writing a response — for callers that
 * need to know "is there a valid session" without gating the request (e.g.
 * the onboarding-status endpoint, which must report `needs_login` rather
 * than 401 when there isn't one).
 */
export const resolveRequestUser = async (
  req: Request
): Promise<User | null> => {
  const authorizationHeader = req.headers["authorization"];
  const apiKeyHeader = req.headers["x-api-key"];

  if (authorizationHeader && authorizationHeader.startsWith("Bearer ")) {
    const bearer = authorizationHeader.substring(7);

    const sessionUser = await findUserBySessionToken(bearer);
    if (sessionUser) return sessionUser;

    const user = await findUserByAccessToken(bearer);
    if (user) return user;
  }

  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    const user = await findUserByApiKey(apiKeyHeader);
    if (user) return user;
  }

  const headers = new Headers();
  if (req.headers.cookie) {
    headers.set("cookie", req.headers.cookie);
  }
  if (req.headers["user-agent"]) {
    headers.set("user-agent", req.headers["user-agent"]);
  }

  const session = await auth.api.getSession({ headers });
  if (session && session.user) {
    return session.user as unknown as User;
  }

  return null;
};

export const protectRoute = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await resolveRequestUser(req);

    if (user) {
      req.user = user;
      return next();
    }

    res.status(401).json({
      error: "UNAUTHORIZED",
      message:
        "You must be logged in or provide valid API credentials to access this resource.",
    });
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).json({
      error: "AUTHENTICATION_ERROR",
      message: "An internal error occurred during authentication.",
    });
  }
};

export const getCurrentUserId = (req: Request): string | null => {
  return req.user?.id || null;
};

export const adminOnly = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (req.user?.role !== "superadmin") {
    res.status(status.FORBIDDEN).json({
      error: "FORBIDDEN",
      message: "You do not have administrative privileges to access this resource.",
    });
    return;
  }
  next();
};

/** Roles allowed to view/edit a store's staff roster. */
const STAFF_MANAGER_ROLES = ["owner", "subadmin", "manager"];

export const requireStaffManager = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user || !STAFF_MANAGER_ROLES.includes(req.user.role ?? "")) {
    res.status(status.FORBIDDEN).json({
      error: "FORBIDDEN",
      message: "You do not have permission to manage staff.",
    });
    return;
  }
  next();
};

/**
 * Must run after protectRoute. Blocks dashboard access until the requesting
 * user's store has finished onboarding (signed up + billing confirmed).
 * Superadmins bypass this — they aren't scoped to any single store.
 */
export const requireActiveOnboarding = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(status.UNAUTHORIZED).json({
      error: "UNAUTHORIZED",
      message: "Authentication required.",
    });
    return;
  }

  if (req.user.role === "superadmin") {
    return next();
  }

  const store = await resolveStoreRow(req.user);

  if (!store || store.onboardingStatus !== "active") {
    res.status(status.FORBIDDEN).json({
      error: "ONBOARDING_INCOMPLETE",
      onboardingStatus: store?.onboardingStatus ?? null,
      message: "This store hasn't finished onboarding yet.",
    });
    return;
  }

  next();
};

export const ensureAuthenticated = async (req: Request): Promise<boolean> => {
  try {
    const headers = new Headers(req.headers as HeadersInit);
    const session = await auth.api.getSession({ headers });
    return !!(session && session.user);
  } catch (error) {
    return false;
  }
};
