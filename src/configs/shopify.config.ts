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
    "read_fulfillments",
    "write_fulfillments",
    "read_returns",
  ],
  hostName: env.SHOPIFY_APP_URL.replace(/^https?:\/\//, ""),
  apiVersion: ADMIN_API_VERSION,
  isEmbeddedApp: true,
  logger: {
    level: LogSeverity.Warning,
  },
});
