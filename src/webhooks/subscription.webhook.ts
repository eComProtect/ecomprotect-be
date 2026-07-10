import { Request, Response } from "express";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { or, eq } from "drizzle-orm";
import { logActivity } from "@/service/logactivity.service";
import { logger } from "@/utils/logger.util";

// ---------------------------------------------------------------------------
// POST /api/webhook/app/subscriptions-update
// Shopify sends this whenever an app subscription's status changes
// (ACTIVE, CANCELLED, DECLINED, EXPIRED, FROZEN, ...).
// When a subscription is no longer ACTIVE we clear the stored plan/package so
// the access gate locks the merchant out until they re-subscribe. Live status is
// always re-verified against Shopify in GET /api/billing/status.
// ---------------------------------------------------------------------------
export const handleAppSubscriptionUpdate = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const shopDomain = req.headers["x-shopify-shop-domain"] as string;
    const subscription = req.body?.app_subscription;
    const newStatus: string | undefined = subscription?.status;

    logger.info(
      `[Billing] app_subscriptions/update — store: ${shopDomain}, status: ${newStatus}`
    );

    if (!shopDomain) {
      res.status(400).json({ error: "Missing x-shopify-shop-domain header" });
      return;
    }

    const store = await database.query.users.findFirst({
      where: (u, { or, eq }) =>
        or(
          eq(u.shopify_url, `https://${shopDomain}`),
          eq(u.shopify_url, shopDomain)
        ),
    });

    if (!store) {
      logger.warn(`[Billing] Store ${shopDomain} not found — skipping.`);
      res.status(200).send("Subscription update acknowledged");
      return;
    }

    const shopFilter = or(
      eq(users.shopify_url, `https://${shopDomain}`),
      eq(users.shopify_url, shopDomain)
    );

    if (newStatus === "ACTIVE") {
      await database
        .update(users)
        .set({
          billingStatus: "active",
          onboardingStatus: "active",
          updatedAt: new Date(),
        })
        .where(shopFilter);
    } else if (newStatus) {
      // Any non-active status (CANCELLED, DECLINED, EXPIRED, FROZEN, ...)
      // locks the merchant back out — onboardingStatus reverts to
      // "signed_up" so GET /api/onboarding/status reports needs_billing
      // again until they re-subscribe.
      await database
        .update(users)
        .set({
          plan: null,
          package: null,
          billingStatus: "inactive",
          onboardingStatus: "signed_up",
          updatedAt: new Date(),
        })
        .where(shopFilter);
    }

    await logActivity({
      action: "APP_SUBSCRIPTION_UPDATE",
      for: "store",
      storeId: store.id,
      meta: {
        shopDomain,
        status: newStatus ?? "unknown",
        name: subscription?.name,
        updatedAt: new Date().toISOString(),
      },
    });

    res.status(200).send("Subscription update processed");
  } catch (err: any) {
    logger.error(
      "[Billing] handleAppSubscriptionUpdate error:",
      err.message
    );
    res.status(500).json({ error: "Failed to process subscription webhook" });
  }
};
