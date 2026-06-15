import { Request, Response } from "express";
import status from "http-status";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "@/service/encryption.service";
import { env } from "@/utils/env.util";
import { logger } from "@/utils/logger.util";
import {
  createAppSubscription,
  getActiveSubscriptions,
  plansForMerchant,
  resolvePlanAmount,
} from "@/utils/billing.util";

/** GET /api/billing/plans — packages with prices resolved for this merchant's tier. */
export const plansController = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.status(status.OK).json({
    message: "Plans fetched successfully",
    data: plansForMerchant(req.user?.average_orders_per_month),
  });
};

/** GET /api/billing/status — whether the store has an active app subscription. */
export const billingStatusController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const shopUrl = req.user?.shopify_url;
    const encryptedToken = req.user?.shopify_access_token;

    if (!shopUrl || !encryptedToken) {
      res.status(status.OK).json({ active: false, subscriptions: [] });
      return;
    }

    const accessToken = decrypt(encryptedToken);
    const subscriptions = await getActiveSubscriptions(shopUrl, accessToken);
    const active = subscriptions.some((s) => s.status === "ACTIVE");

    res.status(status.OK).json({ active, subscriptions });
  } catch (error: any) {
    logger.error(`[Billing] status error: ${error?.message || error}`);
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Failed to fetch subscription status." });
  }
};

/** POST /api/billing/subscribe { package, host } — create a subscription, return confirmationUrl. */
export const subscribeController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const shopUrl = req.user?.shopify_url;
    const encryptedToken = req.user?.shopify_access_token;
    const { package: planName, host } = req.body ?? {};

    if (!shopUrl || !encryptedToken) {
      res.status(status.BAD_REQUEST).json({ message: "Store is not connected." });
      return;
    }
    if (!planName) {
      res.status(status.BAD_REQUEST).json({ message: "package is required." });
      return;
    }

    const resolved = resolvePlanAmount(
      planName,
      req.user?.average_orders_per_month
    );
    if (!resolved) {
      res.status(status.BAD_REQUEST).json({ message: "Unknown package." });
      return;
    }
    if (!resolved.plan.available) {
      res
        .status(status.BAD_REQUEST)
        .json({ message: `${planName} is not available for purchase.` });
      return;
    }

    const shopDomain = shopUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const params = new URLSearchParams({ shop: shopDomain });
    if (host) params.set("host", String(host));
    // Return into the embedded app so the subscription gate re-checks and unlocks.
    const returnUrl = `${env.FRONTEND_DOMAIN}/?${params.toString()}`;

    const accessToken = decrypt(encryptedToken);
    const { confirmationUrl, subscriptionId } = await createAppSubscription({
      shopUrl,
      accessToken,
      planName: resolved.plan.name,
      amount: resolved.amount,
      returnUrl,
    });

    // Record the merchant's intended plan/package (status is confirmed via Shopify).
    await database
      .update(users)
      .set({
        package: resolved.plan.name,
        plan: String(resolved.amount),
        updatedAt: new Date(),
      })
      .where(eq(users.id, req.user!.id));

    logger.info(
      `[Billing] Subscription created (${subscriptionId}) for ${shopDomain}: ${resolved.plan.name} @ ${resolved.amount} GBP`
    );

    res.status(status.OK).json({ confirmationUrl });
  } catch (error: any) {
    logger.error(`[Billing] subscribe error: ${error?.message || error}`);
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: error?.message || "Failed to create subscription." });
  }
};
