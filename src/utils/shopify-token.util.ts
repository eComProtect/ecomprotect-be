import { env } from "@/utils/env.util";
import { shopify } from "@/configs/shopify.config";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { or, eq } from "drizzle-orm";
import { encrypt, decrypt } from "@/service/encryption.service";
import { logger } from "@/utils/logger.util";

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
 * Attempts to automatically migrate a non-expiring (or expired) offline token
 * to a new expiring offline token using Shopify's token exchange endpoint.
 * No merchant redirect required.
 *
 * Returns the new decrypted access token on success, null if migration fails.
 * On success, also updates the users table with the new token + expiry.
 */
export async function attemptTokenMigration(params: {
  shopDomain: string;
  encryptedToken: string;
  userId: string;
}): Promise<{ accessToken: string; expiresAt: Date | null } | null> {
  const { shopDomain, encryptedToken, userId } = params;

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

export const SHOPIFY_TOKEN_EXPIRED_RESPONSE = {
  error: "SHOPIFY_TOKEN_EXPIRED",
  message:
    "Your Shopify access token has expired and could not be automatically renewed. Please reconnect your store.",
} as const;
