import { Request, Response } from "express";
import status from "http-status";
import { database } from "@/configs/connection.config";
import { account, users } from "@/schema/schema";
import { and, eq, ne } from "drizzle-orm";
import {
  findUserByShopDomain,
  resolveRequestUser,
  resolveStoreRow,
} from "@/middlewares/auth.middleware";
import { auth } from "@/lib/auth";
import { createId } from "@paralleldrive/cuid2";

// Matches better-auth's own emailAndPassword defaults (see setPassword /
// changePassword in its source) — kept in sync manually since we hash
// through auth.$context ourselves rather than its session-gated endpoint.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

export type OnboardingStage =
  | "needs_signup"
  | "needs_billing"
  | "needs_login"
  | "ready";

/**
 * GET /api/onboarding/status?shop=<shop-domain>
 *
 * Deliberately does not sit behind protectRoute: needs_signup/needs_billing/
 * needs_login must all be reachable with no valid session at all — that's
 * the whole point of this endpoint.
 */
export const getOnboardingStatusController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const shop = req.query.shop;

  if (typeof shop !== "string" || !shop.trim()) {
    res.status(status.BAD_REQUEST).json({ message: "shop is required." });
    return;
  }

  const shopDomain = shop.trim().replace(/^https?:\/\//, "");
  const owner = await findUserByShopDomain(shopDomain);

  // OAuth install always creates a placeholder owner row immediately (see
  // /shopify/callback), so "no owner row" never actually happens once a shop
  // has installed. The real needs_signup condition is that placeholder still
  // being unfinished: onboardingStatus stays "installed" until the merchant
  // completes the profile-details step, only then advancing to "signed_up".
  if (!owner || owner.onboardingStatus === "installed") {
    res.status(status.OK).json({ status: "needs_signup" satisfies OnboardingStage });
    return;
  }

  if (owner.onboardingStatus !== "active") {
    res.status(status.OK).json({ status: "needs_billing" satisfies OnboardingStage });
    return;
  }

  const sessionUser = await resolveRequestUser(req);
  const sessionStore = sessionUser ? await resolveStoreRow(sessionUser) : null;

  // A session that resolves to a different store than the one being asked
  // about isn't valid for this shop — report needs_login rather than leaking
  // another store's "ready" state.
  if (!sessionStore || sessionStore.id !== owner.id) {
    res.status(status.OK).json({ status: "needs_login" satisfies OnboardingStage });
    return;
  }

  res.status(status.OK).json({ status: "ready" satisfies OnboardingStage });
};

/**
 * POST /api/onboarding/signup
 *
 * Completes the profile-details step for the store's OAuth-created
 * placeholder row (name/email/phone/company_name are all placeholder or
 * empty until now — the row itself already exists with real Shopify
 * credentials from install, see /shopify/callback). Sits behind protectRoute
 * only, not requireActiveOnboarding: the whole point is to run before the
 * store is "active".
 */
export const completeSignupController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const store = req.user;

  if (!store) {
    res.status(status.UNAUTHORIZED).json({ message: "Authentication required." });
    return;
  }

  const { firstName, lastName, phone, companyName, email, password } =
    req.body ?? {};

  if (!firstName || !lastName || !phone || !companyName || !email || !password) {
    res.status(status.BAD_REQUEST).json({
      message:
        "firstName, lastName, phone, companyName, email, and password are all required.",
    });
    return;
  }

  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    res.status(status.BAD_REQUEST).json({
      message: `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
    });
    return;
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  const [emailTaken] = await database
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, normalizedEmail), ne(users.id, store.id)));

  if (emailTaken) {
    res.status(status.BAD_REQUEST).json({ message: "Email already in use." });
    return;
  }

  const [updated] = await database
    .update(users)
    .set({
      name: `${firstName} ${lastName}`.trim(),
      email: normalizedEmail,
      mobile_number: String(phone).trim(),
      company_name: String(companyName).trim(),
      onboardingStatus: "signed_up",
      updatedAt: new Date(),
    })
    .where(eq(users.id, store.id))
    .returning();

  // Give this OAuth-created row a real email/password credential, the same
  // shape better-auth's own setPassword produces, so authClient.signIn.email
  // works afterwards. Its own setPassword endpoint requires an existing
  // session (fine for a logged-in user changing their password, not for this
  // first-time profile-completion step), so we hash through the shared
  // password hasher via auth.$context and write the account row ourselves —
  // this app registers no account-related databaseHooks, so that's the only
  // thing setPassword's own code does beyond this.
  const authContext = await auth.$context;
  const passwordHash = await authContext.password.hash(password);

  const [existingCredential] = await database
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, store.id), eq(account.providerId, "credential")));

  if (existingCredential) {
    await database
      .update(account)
      .set({ password: passwordHash, updatedAt: new Date() })
      .where(eq(account.id, existingCredential.id));
  } else {
    await database.insert(account).values({
      id: createId(),
      userId: store.id,
      providerId: "credential",
      accountId: store.id,
      password: passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  res.status(status.OK).json({ message: "Signup completed.", data: updated });
};
