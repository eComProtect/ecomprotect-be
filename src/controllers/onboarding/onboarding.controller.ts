import { Request, Response } from "express";
import status from "http-status";
import { database } from "@/configs/connection.config";
import { settings, users } from "@/schema/schema";
import { and, eq, ne } from "drizzle-orm";
import {
  findUserByShopDomain,
  resolveRequestUser,
  resolveStoreRow,
} from "@/middlewares/auth.middleware";

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

  const { firstName, lastName, phone, companyName, email } = req.body ?? {};

  if (!firstName || !lastName || !phone || !companyName || !email) {
    res.status(status.BAD_REQUEST).json({
      message:
        "firstName, lastName, phone, companyName, and email are all required.",
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

  // The legacy /sign-up/email flow used to create the store's settings row
  // automatically (see auth.ts's now-removed after-hook) — this is the
  // embedded flow's equivalent point, since completeSignupController is what
  // actually finishes onboarding here. Without it, a fresh store has no
  // settings row at all until someone saves the Settings page once, and
  // fetchSettings/anything reading defaults off it gets nothing back.
  //
  // Embedded merchants authenticate purely via the App Bridge session token
  // (see useIdentity.ts) — there is no standalone login, so no email/password
  // credential is created here.
  const [existingSettings] = await database
    .select({ id: settings.id })
    .from(settings)
    .where(eq(settings.storeId, store.id));

  if (!existingSettings) {
    await database.insert(settings).values({
      storeId: store.id,
      lostParcelThreshold: 3,
      lostParcelPeriod: 1,
      requireESignature: false,
      forceCourierSignedDelivery: false,
      photoOnDelivery: false,
      sendCancellationEmail: false,
    });
  }

  res.status(status.OK).json({ message: "Signup completed.", data: updated });
};
