import { env } from "@/utils/env.util";
import { shopify } from "@/configs/shopify.config";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { or, eq } from "drizzle-orm";
import { encrypt, decrypt } from "@/service/encryption.service";
import { logger } from "@/utils/logger.util";
import { resolveStoreRow } from "@/middlewares/auth.middleware";

type User = typeof users.$inferSelect;

/**
 * Returns true when the Shopify access token needs to be migrated or refreshed.
 *
 * Two cases:
 *  1. expiresAt is null/undefined — old non-expiring token (rejected by Shopify
 *     since July 1 2026). Must migrate via migrateToExpiringToken.
 *  2. expiresAt is set and is in the past — token genuinely expired.
 */
export function isShopifyTokenExpired(
  expiresAt: Date | null | undefined
): boolean {
  if (!expiresAt) return true;
  return new Date() >= new Date(expiresAt);
}

/**
 * Attempts to automatically migrate a non-expiring legacy offline token to a
 * new expiring offline token using Shopify's token exchange endpoint. No
 * merchant redirect required.
 *
 * Only applies to genuinely non-expiring tokens (expiresAt was never set).
 * A modern expiring token that has simply reached its expiry is a different
 * situation — Shopify's migrate-to-expiring endpoint exists to convert a
 * legacy non-expiring token, not to refresh an already-expiring one that
 * expired, and rejects that call with a 400. Offline tokens have no refresh
 * flow once expired; the merchant must re-run OAuth. Callers pass the
 * current expiresAt so this can skip the doomed API call entirely and let
 * the caller fall straight through to its re-auth response.
 *
 * Returns the new decrypted access token on success, null if migration
 * wasn't attempted or failed. On success, also updates the users table with
 * the new token + expiry.
 */
export async function attemptTokenMigration(params: {
  shopDomain: string;
  encryptedToken: string;
  userId: string;
  expiresAt?: Date | null;
}): Promise<{ accessToken: string; expiresAt: Date | null } | null> {
  const { shopDomain, encryptedToken, userId, expiresAt } = params;

  if (expiresAt) {
    // Already a modern expiring token, just past its expiry — migration
    // isn't the right recovery here, re-auth is.
    return null;
  }

  try {
    const decryptedToken = decrypt(encryptedToken);
    if (!decryptedToken) return null;

    const cleanShop = shopDomain.replace(/^https?:\/\//, "");

    const { session } = await shopify.auth.migrateToExpiringToken({
      shop: cleanShop,
      nonExpiringOfflineAccessToken: decryptedToken,
    });

    const newToken = session.accessToken!;
    const newExpiry = session.expires ?? null;
    const newEncryptedToken = encrypt(newToken);

    await database
      .update(users)
      .set({
        shopify_access_token: newEncryptedToken,
        shopify_token_expires_at: newExpiry,
        updatedAt: new Date(),
      })
      .where(
        or(
          eq(users.id, userId),
          eq(users.shopify_url, `https://${cleanShop}`),
          eq(users.shopify_url, cleanShop)
        )
      );

    logger.info(
      `[TokenMigration] Migrated to expiring token for shop ${cleanShop} — expires: ${newExpiry}`
    );

    return { accessToken: newToken, expiresAt: newExpiry };
  } catch (err: any) {
    logger.error(
      `[TokenMigration] Failed to migrate token for shop ${params.shopDomain}: ${err.message}`
    );
    return null;
  }
}

/**
 * Builds the URL that kicks off OAuth for a given shop.
 * The frontend should redirect here when SHOPIFY_TOKEN_EXPIRED is returned
 * and silent migration also fails.
 */
export function shopifyReAuthUrl(shopDomain: string): string {
  const cleanDomain = shopDomain.replace(/^https?:\/\//, "");
  return `${env.SHOPIFY_APP_URL}/shopify/install?shop=${cleanDomain}`;
}

/**
 * Resolves a controller's Shopify access token off the correct row — the
 * store/owner's, not the requesting session's. A staff member's own row
 * carries a copy of the owner's shopify_access_token made at staff-creation
 * time, but never a shopify_token_expires_at (it isn't part of the staff
 * creation payload and isn't a registered better-auth field), so it's always
 * null on a staff row. isShopifyTokenExpired(null) is then always true,
 * triggering attemptTokenMigration on a token that's already an expiring one
 * copied from the owner — which Shopify always rejects with a 400 — forcing
 * a re-auth loop for every staff session on every request. Resolving through
 * resolveStoreRow first means migration/expiry always operates on the
 * store's own real state, and callers get the store's id back for scoping
 * writes (customers.storeId etc.), not the staff member's own id.
 */
export async function resolveStoreShopifyAccess(
  user: User
): Promise<{ store: User; accessToken: string } | null> {
  const store = await resolveStoreRow(user);
  if (!store || !store.shopify_url || !store.shopify_access_token) {
    return null;
  }

  let accessToken = decrypt(store.shopify_access_token);

  if (isShopifyTokenExpired(store.shopify_token_expires_at)) {
    const migrated = await attemptTokenMigration({
      shopDomain: store.shopify_url,
      encryptedToken: store.shopify_access_token,
      userId: store.id,
      expiresAt: store.shopify_token_expires_at,
    });
    if (!migrated) return null;
    accessToken = migrated.accessToken;
  }

  return { store, accessToken };
}

export const SHOPIFY_TOKEN_EXPIRED_RESPONSE = {
  error: "SHOPIFY_TOKEN_EXPIRED",
  message:
    "Your Shopify access token has expired and could not be automatically renewed. Please reconnect your store.",
} as const;
