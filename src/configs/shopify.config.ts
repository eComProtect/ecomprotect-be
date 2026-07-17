import "@shopify/shopify-api/adapters/node";
import { shopifyApi, ApiVersion, LogSeverity } from "@shopify/shopify-api";
import { env } from "@/utils/env.util";

/**
 * Shopify API client — configured for a fully embedded app (runs inside Shopify Admin).
 * hostName is the backend domain (env.SHOPIFY_APP_URL) without the https:// prefix,
 * e.g. SHOPIFY_APP_URL=https://api.ecomprotect.co.uk -> hostName "api.ecomprotect.co.uk".
 */
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
  apiVersion: ApiVersion.July26,
  isEmbeddedApp: true,
  logger: {
    level: LogSeverity.Warning,
  },
});
