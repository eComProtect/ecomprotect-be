import { Request, Response } from "express";
import status from "http-status";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "@/service/encryption.service";
import {
  ShopifyCredentialsError,
  exchangeClientCredentials,
  isValidShopDomain,
  normalizeShopDomain,
} from "@/service/shopifycredentials.service";
import { resolveStoreRow } from "@/middlewares/auth.middleware";
import { SHOPIFY_CUSTOM_APP_SCOPES } from "@/configs/shopify.config";
import { logActivity } from "@/service/logactivity.service";
import { logger } from "@/utils/logger.util";

/**
 * Connecting a store with merchant-supplied custom-app credentials, as an
 * alternative to OAuth (/shopify/callback).
 *
 * The merchant creates a custom app in their own Shopify admin
 * (Settings → Apps and sales channels → Develop apps), installs it, and gives
 * us its Client ID + Client secret. We exchange those for an access token via
 * the client_credentials grant, so the store's Client ID becomes its
 * shopify_api_key and the exchanged token its shopify_access_token — the same
 * two columns the OAuth path writes, which is what lets every existing
 * controller work unchanged.
 *
 * Owner-only: staff rows carry a copy of the owner's token but must not be
 * able to repoint the store's Shopify connection.
 */

type ConnectBody = {
  clientId?: unknown;
  clientSecret?: unknown;
  shopUrl?: unknown;
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** POST /api/shopify/credentials — verify + store custom-app credentials. */
export const connectShopifyCredentialsController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requester = req.user;

  if (!requester) {
    res.status(status.UNAUTHORIZED).json({ message: "Not authenticated." });
    return;
  }

  const store = await resolveStoreRow(requester);

  if (!store) {
    res.status(status.NOT_FOUND).json({ message: "No store found for this account." });
    return;
  }

  if (store.id !== requester.id) {
    res.status(status.FORBIDDEN).json({
      message: "Only the store owner can change the Shopify connection.",
    });
    return;
  }

  const body = (req.body ?? {}) as ConnectBody;
  const clientId = asTrimmedString(body.clientId);
  const clientSecret = asTrimmedString(body.clientSecret);

  if (!clientId || !clientSecret) {
    res.status(status.BAD_REQUEST).json({
      message: "Both Client ID and Client secret are required.",
    });
    return;
  }

  // The store URL is normally already on the row (set at signup); accept an
  // explicit one so a store that never went through OAuth can supply it here.
  const submittedShopUrl = asTrimmedString(body.shopUrl);

  // Bare domain, used ONLY for validation and for building the Shopify request
  // URL (which can't contain a protocol). Never written back to the row:
  // shopify_url is stored as the merchant typed it — signup requires a full
  // "https://…" URL — and rewriting it to a bare domain would change the format
  // other lookups and the owner-unique index match on.
  const shopDomain = normalizeShopDomain(
    submittedShopUrl || store.shopify_url || ""
  );

  if (!isValidShopDomain(shopDomain)) {
    res.status(status.BAD_REQUEST).json({
      message:
        "A valid Shopify store URL is required, in the form storename.myshopify.com",
    });
    return;
  }

  try {
    const { accessToken, expiresAt, scope } = await exchangeClientCredentials({
      shopDomain,
      clientId,
      clientSecret,
    });

    await database
      .update(users)
      .set({
        // Left untouched when the row already has one. Only filled in for a
        // store that has none yet, and then verbatim as the merchant entered it.
        ...(store.shopify_url || !submittedShopUrl
          ? {}
          : { shopify_url: submittedShopUrl }),
        shopify_api_key: clientId,
        shopify_client_secret: encrypt(clientSecret),
        shopify_access_token: encrypt(accessToken),
        shopify_token_expires_at: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, store.id));

    await logActivity({
      action: "STORE_CREDENTIALS_CONNECTED",
      for: "store",
      storeId: store.id,
      meta: { shopDomain, scope },
    });

    res.status(status.OK).json({
      connected: true,
      shopUrl: store.shopify_url || submittedShopUrl,
      scope,
      expiresAt,
    });
  } catch (err: any) {
    if (err instanceof ShopifyCredentialsError) {
      res.status(err.status).json({ message: err.message });
      return;
    }

    logger.error(
      `[ClientCredentials] Unexpected failure connecting ${shopDomain}: ${err?.message}`
    );
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Failed to connect the store. Please try again." });
  }
};

/**
 * GET /api/shopify/credentials — connection state for the UI, plus the scope
 * list the merchant must configure on their custom app (served from
 * shopify.config.ts so the instructions live in one place rather than being
 * duplicated in the frontend).
 *
 * Returns whether credentials are stored and a masked Client ID; never the
 * secret or the access token.
 */
export const getShopifyCredentialsStatusController = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requester = req.user;

  if (!requester) {
    res.status(status.UNAUTHORIZED).json({ message: "Not authenticated." });
    return;
  }

  const store = await resolveStoreRow(requester);

  if (!store) {
    res.status(status.NOT_FOUND).json({ message: "No store found for this account." });
    return;
  }

  const clientId = store.shopify_api_key ?? "";

  res.status(status.OK).json({
    connected: Boolean(store.shopify_access_token),
    usesClientCredentials: Boolean(store.shopify_client_secret),
    shopUrl: store.shopify_url ?? null,
    clientIdPreview: clientId ? `${clientId.slice(0, 6)}••••${clientId.slice(-4)}` : null,
    expiresAt: store.shopify_token_expires_at,
    requiredScopes: SHOPIFY_CUSTOM_APP_SCOPES,
  });
};
