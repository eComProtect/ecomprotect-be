import { Router } from "express";
import express from "express";
import { verifyWebhookHmac } from "@/middlewares/webhookhmac.middleware";
import { ordersCreateWebhook } from "@/webhooks/order.webhook";
import { refundsCreateWebhook } from "@/webhooks/refunds.webhook";
import {
  handleCustomerDataRequest,
  handleCustomerRedact,
  handleShopRedact,
} from "@/webhooks/gdpr.webhook";
import { handleAppUninstalled } from "@/webhooks/uninstall.webhook";
import { handleAppSubscriptionUpdate } from "@/webhooks/subscription.webhook";
import { stripeWebhook } from "@/webhooks/stripe.webhook";

const webhookRouter = Router();

// Shared middleware stack for all webhook routes:
// express.raw() captures the raw buffer for HMAC, then verifyWebhookHmac validates it.
const webhookMiddleware = [
  express.raw({ type: "application/json" }),
  verifyWebhookHmac,
];

// ---------------------------------------------------------------------------
// Existing webhooks
// ---------------------------------------------------------------------------
webhookRouter.post("/orders/create", ...webhookMiddleware, ordersCreateWebhook);
webhookRouter.post("/refunds/create", ...webhookMiddleware, refundsCreateWebhook);

// ---------------------------------------------------------------------------
// GDPR — mandatory for Shopify App Store listing
// ---------------------------------------------------------------------------
webhookRouter.post(
  "/customers/data-request",
  ...webhookMiddleware,
  handleCustomerDataRequest
);
webhookRouter.post(
  "/customers/redact",
  ...webhookMiddleware,
  handleCustomerRedact
);
webhookRouter.post("/shop/redact", ...webhookMiddleware, handleShopRedact);

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
webhookRouter.post(
  "/app/uninstalled",
  ...webhookMiddleware,
  handleAppUninstalled
);
webhookRouter.post(
  "/app/subscriptions-update",
  ...webhookMiddleware,
  handleAppSubscriptionUpdate
);

// ---------------------------------------------------------------------------
// Stripe — website subscription payments
// ---------------------------------------------------------------------------
// Raw body like the others (Stripe signs the exact bytes), but deliberately NOT
// behind verifyWebhookHmac: that middleware validates Shopify's
// X-Shopify-Hmac-Sha256 and would reject every Stripe delivery. Stripe's own
// signature check happens inside the handler.
webhookRouter.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  stripeWebhook
);

export default webhookRouter;
