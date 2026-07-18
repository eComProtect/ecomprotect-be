import { Request, Response } from "express";
import status from "http-status";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { eq } from "drizzle-orm";
import { env } from "@/utils/env.util";
import { logger } from "@/utils/logger.util";
import {
  createAppSubscription,
  getActiveSubscriptions,
  plansForMerchant,
  resolvePlanAmount,
} from "@/utils/billing.util";
import { resolveStoreRow } from "@/middlewares/auth.middleware";
import {
  resolveStoreShopifyAccess,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

/**
 * GET /api/billing/plans — packages with prices resolved for an order tier.
 * The tier comes from ?orders=<range> (what the merchant picks on the billing page),
 * falling back to the stored users.average_orders_per_month.
 */
export const plansController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const orders =
    (req.query.orders as string | undefined) ||
    req.user?.average_orders_per_month;

  res.status(status.OK).json({
    message: "Plans fetched successfully",
    data: plansForMerchant(orders),
  });
};

/** GET /api/billing/status — whether the store has an active app subscription. */
export const billingStatusController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(status.OK).json({ active: false, subscriptions: [] });
      return;
    }

    const store = await resolveStoreRow(req.user);
    if (!store || !store.shopify_url || !store.shopify_access_token) {
      res.status(status.OK).json({ active: false, subscriptions: [] });
      return;
    }
    const shopUrl = store.shopify_url;

    const resolved = await resolveStoreShopifyAccess(req.user);
    if (!resolved) {
      res.status(status.UNAUTHORIZED).json({
        ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
        reAuthUrl: shopifyReAuthUrl(shopUrl),
      });
      return;
    }
    const { accessToken } = resolved;

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
    const { package: planName, host, orders } = req.body ?? {};

    if (!req.user) {
      res.status(status.UNAUTHORIZED).json({ message: "Not authenticated" });
      return;
    }

    const store = await resolveStoreRow(req.user);
    if (!store || !store.shopify_url || !store.shopify_access_token) {
      res.status(status.BAD_REQUEST).json({ message: "Store is not connected." });
      return;
    }
    const shopUrl = store.shopify_url;

    if (!planName) {
      res.status(status.BAD_REQUEST).json({ message: "package is required." });
      return;
    }

    // The order tier drives the price: prefer what the merchant just selected,
    // else the previously stored value.
    const ordersTier: string | undefined =
      orders || store.average_orders_per_month || undefined;

    const resolved = resolvePlanAmount(planName, ordersTier);
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

    const storeAccess = await resolveStoreShopifyAccess(req.user);
    if (!storeAccess) {
      res.status(status.UNAUTHORIZED).json({
        ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
        reAuthUrl: shopifyReAuthUrl(shopUrl),
      });
      return;
    }
    const { accessToken } = storeAccess;

    const { confirmationUrl, subscriptionId } = await createAppSubscription({
      shopUrl,
      accessToken,
      planName: resolved.plan.name,
      amount: resolved.amount,
      returnUrl,
    });

    // Record the merchant's intended plan/package and chosen order tier
    // (subscription status itself is always confirmed live via Shopify, and
    // onboardingStatus only flips to "active" once the subscriptions-update
    // webhook confirms the charge — see subscription.webhook.ts).
    await database
      .update(users)
      .set({
        package: resolved.plan.name,
        plan: String(resolved.amount),
        billingStatus: "pending",
        ...(ordersTier ? { average_orders_per_month: ordersTier } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, store.id));

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
