import { Request, Response } from "express";
import status from "http-status";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  resolveRequestUser,
  resolveStoreRow,
} from "@/middlewares/auth.middleware";

export type OnboardingStage =
  | "needs_signup"
  | "needs_billing"
  | "needs_login"
  | "ready";

const findStoreOwnerByShopDomain = async (shopDomain: string) => {
  const [owner] = await database
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

  return owner ?? null;
};

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
  const owner = await findStoreOwnerByShopDomain(shopDomain);

  if (!owner) {
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
