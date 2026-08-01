import { Router, Request, Response } from "express";
import { shopify } from "@/configs/shopify.config";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { or, eq } from "drizzle-orm";
import { encrypt } from "@/service/encryption.service";
import { env } from "@/utils/env.util";
import { logger } from "@/utils/logger.util";
import { createId } from "@paralleldrive/cuid2";
import { logActivity } from "@/service/logactivity.service";

const shopifyRouter = Router();

// ---------------------------------------------------------------------------
// GET /shopify/install?shop=storename.myshopify.com
// Begins OAuth — validates shop param, generates authorization URL, redirects.
// ---------------------------------------------------------------------------
shopifyRouter.get("/install", async (req: Request, res: Response): Promise<void> => {
  try {
    const shop = req.query.shop as string | undefined;

    if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)) {
      res.status(400).json({
        error:
          "Invalid or missing shop parameter. Must be in format: storename.myshopify.com",
      });
      return;
    }

    // Build a throwaway session object — shopify-api needs this to generate the URL
    const authRoute = await shopify.auth.begin({
      shop,
      callbackPath: "/shopify/callback",
      isOnline: false, // offline token (permanent)
      rawRequest: req,
      rawResponse: res,
    });

    // shopify.auth.begin() writes the redirect itself via rawResponse
    // If it returns a URL (some versions), redirect manually
    if (authRoute && typeof authRoute === "string") {
      res.redirect(authRoute);
    }
  } catch (err: any) {
    logger.error("[OAuth] /install error:", err.message);
    res.status(500).json({ error: "Failed to begin Shopify OAuth" });
  }
});

// ---------------------------------------------------------------------------
// GET /shopify/callback
// Shopify redirects here after merchant grants permissions.
// Validates HMAC + state, exchanges code for permanent access token,
// upserts user record, registers webhooks, redirects to dashboard.
// ---------------------------------------------------------------------------
shopifyRouter.get("/callback", async (req: Request, res: Response): Promise<void> => {
  try {
    // Validates HMAC, state cookie, and exchanges the code for a token
    const callbackResponse = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    // Prevent SDK embedded redirect
    res.removeHeader('location');

    const shopDomain = callbackResponse.session.shop; // e.g. "storename.myshopify.com"

    // The classic authorization-code-grant flow (this handler) always returns
    // a non-expiring offline token — that hasn't changed in v13. Shopify's
    // Admin API now rejects non-expiring tokens outright, so every fresh
    // token from here must be migrated via the dedicated token-exchange
    // endpoint before it's stored or used for anything (webhook registration
    // below would otherwise 403 immediately).
    let session;
    try {
      ({ session } = await shopify.auth.migrateToExpiringToken({
        shop: shopDomain,
        nonExpiringOfflineAccessToken: callbackResponse.session.accessToken!,
      }));
    } catch (migrateErr: any) {
      logger.error(
        `[OAuth] Failed to migrate to an expiring token for ${shopDomain}: ${migrateErr.message}`
      );
      throw migrateErr;
    }

    const accessToken = session.accessToken!;
    const tokenExpiresAt = session.expires ?? null;
    const encryptedToken = encrypt(accessToken);

    logger.info(`[OAuth] Callback success for shop: ${shopDomain}`);

    // Upsert user record. Scoped to the owner row (storeOwnerId IS NULL) —
    // without this, a store with staff accounts (which share shopify_url)
    // could resolve "existingUser" to a staff row instead of the owner,
    // same class of bug fixed elsewhere this session in findUserByShopDomain.
    const existingUser = await database.query.users.findFirst({
      where: (u, { and, or, eq, isNull }) =>
        and(
          or(
            eq(u.shopify_url, `https://${shopDomain}`),
            eq(u.shopify_url, shopDomain)
          ),
          isNull(u.storeOwnerId)
        ),
    });

    if (existingUser) {
      // Update tokens on existing record
      await database
        .update(users)
        .set({
          shopify_access_token: encryptedToken,
          shopify_token_expires_at: tokenExpiresAt,
          shopify_api_key: env.SHOPIFY_API_KEY,
          updatedAt: new Date(),
        })
        .where(
          or(
            eq(users.shopify_url, `https://${shopDomain}`),
            eq(users.shopify_url, shopDomain)
          )
        );

      logger.info(`[OAuth] Updated tokens for existing store: ${shopDomain}`);

      await logActivity({
        action: "APP_REINSTALLED",
        for: "store",
        storeId: existingUser.id,
        meta: { shopDomain, reinstalledAt: new Date().toISOString() },
      });
    } else {
      // Create minimal user record for new merchants
      const newUserId = createId();

      await database.insert(users).values({
        id: newUserId,
        name: shopDomain,
        email: `${shopDomain.replace(".myshopify.com", "")}@shopify.placeholder`,
        emailVerified: false,
        // Without this, the row falls back to the schema's "subadmin" default,
        // which isn't even a registered role in the admin plugin's access
        // control — leaving the actual store owner unable to manage staff.
        role: "owner",
        shopify_url: `https://${shopDomain}`,
        shopify_access_token: encryptedToken,
        shopify_token_expires_at: tokenExpiresAt,
        shopify_api_key: env.SHOPIFY_API_KEY,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      logger.info(`[OAuth] Created new user record for store: ${shopDomain}`);

      await logActivity({
        action: "APP_INSTALLED",
        for: "store",
        storeId: newUserId,
        meta: { shopDomain, installedAt: new Date().toISOString() },
      });
    }

    // Operational, compliance, and uninstall webhooks are declared statically
    // in shopify.app.toml and auto-subscribed by Shopify on install — no
    // per-shop registration call needed here.
    const host = (req.query.host as string | undefined) ?? "";

    // No host means OAuth wasn't started from inside the Admin iframe — e.g. a
    // merchant reconnecting an expired token from the standalone website. The
    // embedded redirect below would then land on FRONTEND_DOMAIN?shop=…&host=,
    // which EmbeddedEntry reads as not-embedded and answers with the marketing
    // homepage — so a website user reconnecting got bounced out of the app.
    // Send them back to their dashboard instead.
    if (!host) {
      logger.info(`[OAuth] Completed without host (standalone) for ${shopDomain}`);
      res.redirect(`${env.FRONTEND_DOMAIN}/user/customer-management`);
      return;
    }

    // Redirect back into the embedded app. We pass shop + host so App Bridge can
    // boot inside the Shopify Admin iframe; the frontend then authenticates every
    // request with a short-lived App Bridge session token (no token in the URL).
    const params = new URLSearchParams({ shop: shopDomain, host });
    res.redirect(`${env.FRONTEND_DOMAIN}?${params.toString()}`);
  } catch (err: any) {
    logger.error("[OAuth] /callback error:", err.message);
    res.status(500).json({ error: "Failed to complete Shopify OAuth", details: err.message });
  }
});

export default shopifyRouter;
