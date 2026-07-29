import axios from "axios";
import { logger } from "@/utils/logger.util";

/**
 * Shopify's client_credentials grant.
 *
 * An alternative to the OAuth authorization-code flow (/shopify/callback) for
 * merchants who create a custom app in their own Shopify admin
 * (Settings → Apps and sales channels → Develop apps) and hand us its
 * Client ID + Client secret. No merchant redirect, no app-store listing, and
 * no App Bridge — which is what makes it usable from the standalone website
 * while the public app is still pending review.
 *
 * POST https://{shop}/admin/oauth/access_token
 *   { client_id, client_secret, grant_type: "client_credentials" }
 *
 * Unlike the authorization-code flow, the token this returns is short-lived,
 * so the credentials are stored (encrypted) and the grant re-run to renew —
 * see refreshViaClientCredentials in shopify-token.util.ts. That also means
 * there is no migrateToExpiringToken step here: these tokens are already
 * expiring ones.
 */

/** Fallback lifetime when Shopify omits expires_in — deliberately short, since
 *  renewing is a single cheap call and a wrong-but-long guess would let a dead
 *  token sit in the DB looking valid. */
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 24;

export type ShopifyClientCredentials = {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
};

export type ExchangedToken = {
  accessToken: string;
  expiresAt: Date;
  scope: string | null;
};

export class ShopifyCredentialsError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ShopifyCredentialsError";
    this.status = status;
  }
}

/** Strips protocol/trailing slashes so the value is safe to interpolate into
 *  the admin URL and to compare against stored shopify_url values. */
export const normalizeShopDomain = (value: string) =>
  value
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();

export const isValidShopDomain = (value: string) =>
  /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value);

export async function exchangeClientCredentials(
  params: ShopifyClientCredentials
): Promise<ExchangedToken> {
  const shop = normalizeShopDomain(params.shopDomain);

  if (!isValidShopDomain(shop)) {
    throw new ShopifyCredentialsError(
      "Invalid shop domain. Expected the form storename.myshopify.com"
    );
  }

  const clientId = params.clientId.trim();
  const clientSecret = params.clientSecret.trim();

  if (!clientId || !clientSecret) {
    throw new ShopifyCredentialsError(
      "Both Client ID and Client secret are required."
    );
  }

  try {
    const { data } = await axios.post<{
      access_token?: string;
      scope?: string;
      expires_in?: number;
    }>(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15_000,
      }
    );

    if (!data?.access_token) {
      throw new ShopifyCredentialsError(
        "Shopify accepted the request but returned no access token."
      );
    }

    const ttlSeconds =
      typeof data.expires_in === "number" && data.expires_in > 0
        ? data.expires_in
        : DEFAULT_TOKEN_TTL_SECONDS;

    logger.info(
      `[ClientCredentials] Issued token for ${shop} — expires in ${ttlSeconds}s, scope: ${data.scope ?? "unknown"}`
    );

    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      scope: data.scope ?? null,
    };
  } catch (err: any) {
    if (err instanceof ShopifyCredentialsError) throw err;

    const status = err?.response?.status;
    const body = err?.response?.data;

    // Errors from this endpoint come back as a full HTML page, not JSON — log a
    // truncated form so a stack of markup doesn't drown the logs.
    const rawBody = typeof body === "string" ? body : JSON.stringify(body ?? "");
    const detail = rawBody ? rawBody.slice(0, 300) : err?.message;

    logger.error(
      `[ClientCredentials] Token request failed for ${shop}: status=${status} ${detail}`
    );

    // The grant issues tokens for an app that is already installed on the
    // shop — it is not itself an install step. Verified against a live shop:
    // an uninstalled app returns 400 "Oauth error app_not_installed", which is
    // the single most likely merchant mistake here, so name the fix.
    if (rawBody.includes("app_not_installed")) {
      throw new ShopifyCredentialsError(
        `That app isn't installed on ${shop} yet. In your Shopify admin open Settings → Apps and sales channels → Develop apps, select the app, click "Install app", then try again.`
      );
    }

    // 400/401 otherwise means the merchant's own input is wrong, so say which
    // part rather than surfacing Shopify's terse error_description.
    if (status === 400 || status === 401) {
      throw new ShopifyCredentialsError(
        "Shopify rejected these credentials. Check the Client ID and Client secret are from this store's custom app, copied without extra spaces."
      );
    }

    if (status === 404) {
      throw new ShopifyCredentialsError(
        `No Shopify store found at ${shop}. Check the store URL.`
      );
    }

    throw new ShopifyCredentialsError(
      "Could not reach Shopify to verify these credentials. Please try again.",
      502
    );
  }
}
