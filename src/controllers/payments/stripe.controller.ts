import { env } from "@/utils/env.util";
import { logger } from "./../../utils/logger.util";
import { Response } from "express";
import { Request } from "express";
import status from "http-status";
import Stripe from "stripe";
import { resolveStoreRow } from "@/middlewares/auth.middleware";

/**
 * POST /api/payment/create-stripe { priceId } — start Stripe Checkout.
 *
 * The session carries the store's id in client_reference_id (and metadata), so
 * the webhook (stripe.webhook.ts) can attribute the payment back to a store and
 * activate it. Without that link the merchant paid and nothing in the database
 * ever found out — they stayed stuck at onboardingStatus "signed_up", which
 * 403s every data endpoint via requireActiveOnboarding.
 *
 * Behind protectRoute: sign-up auto-signs the merchant in, so the post-signup
 * package step always has a session, and a payment must never be startable for
 * an unidentified user.
 */
export const StripePayment = async (req: Request, res: Response) => {
  try {
    const { priceId } = req.body;

    if (!priceId) {
      res.status(status.BAD_REQUEST).json({ message: "No id provided" });
      return;
    }

    if (!req.user) {
      res.status(status.UNAUTHORIZED).json({ message: "Not authenticated." });
      return;
    }

    // Bill the store, not the individual — a staff member's row must never
    // become the subscription holder.
    const store = await resolveStoreRow(req.user);

    if (!store) {
      res
        .status(status.NOT_FOUND)
        .json({ message: "No store found for this account." });
      return;
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      client_reference_id: store.id,
      customer_email: store.email,
      metadata: {
        storeId: store.id,
        startedByUserId: req.user.id,
        priceId,
      },
      // Carried onto the subscription itself so subscription.* events (renewal,
      // cancellation) are attributable too, not just the initial checkout.
      subscription_data: {
        metadata: {
          storeId: store.id,
          priceId,
        },
      },
      success_url: `${env.FRONTEND_DOMAIN}/under-review?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.FRONTEND_DOMAIN}/cancel`,
    });

    logger.info(
      `[Stripe] Checkout session ${session.id} created for store ${store.id} (price ${priceId})`
    );

    res.status(status.OK).json({ url: session.url });
  } catch (error) {
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Internal Error, something went wrong" });
    logger.error(`[Stripe] Checkout session creation failed: ${error}`);
  }
};
