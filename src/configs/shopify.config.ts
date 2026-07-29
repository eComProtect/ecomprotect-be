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

/**
 * Scopes a merchant must enable on the custom app they build in their own dev
 * dashboard before connecting it here via the client_credentials grant (see
 * connectcredentials.controller.ts). Served to the connect-store UI by
 * GET /api/shopify/credentials so the on-screen instructions live in one place.
 *
 * Deliberately separate from SHOPIFY_REQUIRED_SCOPES below, which is what this
 * app itself requests during OAuth. This list is a superset: it contains every
 * OAuth scope plus extras (products, reports, checkouts, companies, draft
 * orders) and the customer_* Customer Account API scopes, which aren't valid in
 * an Admin OAuth scope request at all. Granting more than OAuth asks for is
 * harmless; folding these into the OAuth request would not be.
 */
export const SHOPIFY_CUSTOM_APP_SCOPES = [
  "read_assigned_fulfillment_orders",
  "write_assigned_fulfillment_orders",
  "write_checkouts",
  "read_checkouts",
  "read_companies",
  "write_companies",
  "read_customers",
  "write_customers",
  "write_draft_orders",
  "read_draft_orders",
  "read_fulfillments",
  "write_fulfillments",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "read_orders",
  "write_orders",
  "read_products",
  "write_products",
  "write_reports",
  "read_reports",
  "read_returns",
  "read_third_party_fulfillment_orders",
  "write_third_party_fulfillment_orders",
  "customer_read_companies",
  "customer_write_companies",
  "customer_write_customers",
  "customer_read_customers",
  "customer_read_draft_orders",
  "customer_read_orders",
  "customer_write_orders",
] as const;

/**
 * Admin API scopes this app requests for itself during OAuth
 * (shopify.auth.begin → /shopify/callback). Changing this list changes what
 * merchants are asked to consent to and re-triggers consent for existing
 * installs, so it is kept narrow and separate from the custom-app list above.
 */
export const SHOPIFY_REQUIRED_SCOPES = [
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
] as const;

export const shopify = shopifyApi({
  apiKey: env.SHOPIFY_API_KEY,
  apiSecretKey: env.SHOPIFY_API_SECRET,
  scopes: [...SHOPIFY_REQUIRED_SCOPES],
  hostName: env.SHOPIFY_APP_URL.replace(/^https?:\/\//, ""),
  apiVersion: ADMIN_API_VERSION,
  isEmbeddedApp: true,
  logger: {
    level: LogSeverity.Warning,
  },
});
