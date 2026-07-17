import "@shopify/shopify-api/adapters/node";
import { shopifyApi, ApiVersion, LogSeverity } from "@shopify/shopify-api";
import { env } from "@/utils/env.util";

/**
 * Shopify API client — configured for a fully embedded app (runs inside Shopify Admin).
 * hostName is the backend domain (env.SHOPIFY_APP_URL) without the https:// prefix,
 * e.g. SHOPIFY_APP_URL=https://api.ecomprotect.co.uk -> hostName "api.ecomprotect.co.uk".
 */
// Single source of truth for the Admin API version — every hand-rolled
// axios call to /admin/api/{version}/graphql.json across the codebase
// should import this rather than hardcoding the version string, so a
// library apiVersion bump can't silently leave those calls pointed at a
// version Shopify has since sunset (see ADMIN_API_VERSION usages).
export const ADMIN_API_VERSION = ApiVersion.July26;

export const shopify = shopifyApi({
  apiKey: env.SHOPIFY_API_KEY,
  apiSecretKey: env.SHOPIFY_API_SECRET,
  scopes: [
    "read_customers",
    "write_customers",
    "read_orders",
    "write_orders",
    // NOTE: read_fulfillments/write_fulfillments are the *Fulfillment* API
    // (shipments/tracking) — they do NOT grant access to fulfillment
    // ORDERS. The order.fulfillmentOrders connection and the
    // fulfillmentOrderHold mutation require the *_fulfillment_orders scopes
    // below. Without them, Shopify silently returns an empty
    // fulfillmentOrders list (no error), which is why auto-hold was a
    // no-op. merchant_managed = self-fulfilled, assigned = via a
    // fulfillment service, third_party = 3rd-party fulfillment apps; a
    // hold must work regardless of how the merchant fulfills, so we
    // request read+write for all three.
    "read_fulfillments",
    "write_fulfillments",
    "read_merchant_managed_fulfillment_orders",
    "write_merchant_managed_fulfillment_orders",
    "read_assigned_fulfillment_orders",
    "write_assigned_fulfillment_orders",
    "read_third_party_fulfillment_orders",
    "write_third_party_fulfillment_orders",
    "read_returns",
  ],
  hostName: env.SHOPIFY_APP_URL.replace(/^https?:\/\//, ""),
  apiVersion: ADMIN_API_VERSION,
  isEmbeddedApp: true,
  logger: {
    level: LogSeverity.Warning,
  },
});
