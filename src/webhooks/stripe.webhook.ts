import { Request, Response } from "express";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { env } from "@/utils/env.util";
import { logger } from "@/utils/logger.util";
import { logActivity } from "@/service/logactivity.service";

/**
 * POST /api/webhook/stripe
 *
 * The website's payment path, and the only thing that activates a store while
 * the Shopify app is pending App Store approval — Shopify's Billing API (and
 * therefore subscription.webhook.ts) is unavailable to custom-distribution
 * apps, so it can never fire for merchants onboarded that way.
 *
 * Mounted before express.json() (see server.ts) so req.body is the raw Buffer
 * Stripe's signature check requires. Parsing it first would break verification.
 *
 * Configure in Stripe → Developers → Webhooks with these events:
 *   checkout.session.completed
 *   customer.subscription.updated
 *   customer.subscription.deleted
 */

/** Stripe subscription statuses that should keep the store unlocked. */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

const activateStore = async (params: {
  storeId: string;
  customerId: string | null;
  subscriptionId: string | null;
  source: string;
}) => {
  const { storeId, customerId, subscriptionId, source } = params;

  const [updated] = await database
    .update(users)
    .set({
      billingStatus: "active",
      // The gate requireActiveOnboarding checks. Everything the merchant just
      // paid for stays 403'd until this is "active".
      onboardingStatus: "active",
      ...(customerId ? { stripe_customer_id: customerId } : {}),
      ...(subscriptionId ? { stripe_subscription_id: subscriptionId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, storeId))
    .returning({ id: users.id });

  if (!updated) {
    logger.error(
      `[Stripe] ${source}: no store row matched id ${storeId} — payment not applied`
    );
    return;
  }

  logger.info(`[Stripe] ${source}: store ${storeId} activated`);

  await logActivity({
    action: "BILLING_ACTIVATED",
    for: "store",
    storeId,
    meta: { provider: "stripe", subscriptionId, source },
  });
};

const deactivateStore = async (params: {
  subscriptionId: string;
  billingStatus: string;
  source: string;
}) => {
  const { subscriptionId, billingStatus, source } = params;

  // Matched on the stored subscription id — the reason stripe_subscription_id
  // is persisted at activation time.
  const store = await database.query.users.findFirst({
    where: eq(users.stripe_subscription_id, subscriptionId),
  });

  if (!store) {
    logger.warn(
      `[Stripe] ${source}: no store found for subscription ${subscriptionId}`
    );
    return;
  }

  await database
    .update(users)
    .set({
      billingStatus,
      // Back to the pre-payment state rather than "installed", which would
      // send the merchant through profile signup again.
      onboardingStatus: "signed_up",
      updatedAt: new Date(),
    })
    .where(eq(users.id, store.id));

  logger.info(
    `[Stripe] ${source}: store ${store.id} deactivated (${billingStatus})`
  );

  await logActivity({
    action: "BILLING_DEACTIVATED",
    for: "store",
    storeId: store.id,
    meta: { provider: "stripe", subscriptionId, billingStatus, source },
  });
};

export const stripeWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  const signature = req.headers["stripe-signature"];

  if (!env.STRIPE_WEBHOOK_SECRET) {
    logger.error(
      "[Stripe] Webhook received but STRIPE_WEBHOOK_SECRET is not set — cannot verify, ignoring."
    );
    res.status(500).json({ error: "Webhook not configured" });
    return;
  }

  if (!signature || typeof signature !== "string") {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    // Almost always either a wrong signing secret or a body that got parsed
    // before reaching here.
    logger.error(`[Stripe] Signature verification failed: ${err.message}`);
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // Acknowledge before doing the work: Stripe retries on non-2xx, and a slow
  // database write shouldn't turn into duplicate deliveries.
  res.status(200).json({ received: true });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        const storeId =
          session.client_reference_id ?? session.metadata?.storeId ?? null;

        if (!storeId) {
          logger.error(
            `[Stripe] checkout.session.completed ${session.id} has no client_reference_id/metadata.storeId — cannot attribute payment`
          );
          return;
        }

        // Subscription-mode sessions can complete before the payment settles
        // (e.g. delayed card authentication); only unlock on a paid session.
        if (session.payment_status === "unpaid") {
          logger.info(
            `[Stripe] checkout.session.completed ${session.id} for store ${storeId} is still unpaid — waiting for subscription events`
          );
          return;
        }

        await activateStore({
          storeId,
          customerId:
            typeof session.customer === "string" ? session.customer : null,
          subscriptionId:
            typeof session.subscription === "string"
              ? session.subscription
              : null,
          source: "checkout.session.completed",
        });
        return;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const storeId = subscription.metadata?.storeId ?? null;

        if (ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
          // Covers recovery after a failed payment, and the case where the
          // checkout session itself completed unpaid.
          if (!storeId) {
            logger.warn(
              `[Stripe] customer.subscription.updated ${subscription.id} active but carries no metadata.storeId`
            );
            return;
          }
          await activateStore({
            storeId,
            customerId:
              typeof subscription.customer === "string"
                ? subscription.customer
                : null,
            subscriptionId: subscription.id,
            source: `customer.subscription.updated (${subscription.status})`,
          });
          return;
        }

        await deactivateStore({
          subscriptionId: subscription.id,
          billingStatus: subscription.status,
          source: `customer.subscription.updated (${subscription.status})`,
        });
        return;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await deactivateStore({
          subscriptionId: subscription.id,
          billingStatus: "canceled",
          source: "customer.subscription.deleted",
        });
        return;
      }

      default:
        logger.info(`[Stripe] Ignoring unhandled event type ${event.type}`);
    }
  } catch (err: any) {
    // Response is already sent; log loudly rather than leaving it silent.
    logger.error(
      `[Stripe] Failed handling ${event.type} (${event.id}): ${err?.message}`
    );
  }
};
