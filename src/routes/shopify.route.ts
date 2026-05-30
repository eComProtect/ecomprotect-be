import { Router, Request, Response } from "express";
import { shopify } from "@/configs/shopify.config";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { or, eq } from "drizzle-orm";
import { encrypt } from "@/service/encryption.service";
import { registerRequiredWebhooks } from "@/utils/webhook.util";
import { env } from "@/utils/env.util";
import { logger } from "@/utils/logger.util";
import { createId } from "@paralleldrive/cuid2";
import { auth } from "@/lib/auth";

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

    const session = callbackResponse.session;
    const shopDomain = session.shop; // e.g. "storename.myshopify.com"
    const accessToken = session.accessToken!;
    const encryptedToken = encrypt(accessToken);
    let userId: string;

    logger.info(`[OAuth] Callback success for shop: ${shopDomain}`);

    // Upsert user record
    const existingUser = await database.query.users.findFirst({
      where: (u, { or, eq }) =>
        or(
          eq(u.shopify_url, `https://${shopDomain}`),
          eq(u.shopify_url, shopDomain)
        ),
    });

    if (existingUser) {
      userId = existingUser.id;

      // Update tokens on existing record
      await database
        .update(users)
        .set({
          shopify_access_token: encryptedToken,
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
    } else {
      // Create minimal user record for new merchants
      const newUserId = createId();
      userId = newUserId;

      await database.insert(users).values({
        id: newUserId,
        name: shopDomain,
        email: `${shopDomain.replace(".myshopify.com", "")}@shopify.placeholder`,
        emailVerified: false,
        shopify_url: `https://${shopDomain}`,
        shopify_access_token: encryptedToken,
        shopify_api_key: env.SHOPIFY_API_KEY,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      logger.info(`[OAuth] Created new user record for store: ${shopDomain}`);
    }

    // Register operational, compliance, and uninstall webhooks
    const shopUrl = `https://${shopDomain}`;
    try {
      const webhookSummary = await registerRequiredWebhooks(shopUrl, accessToken);
      if (webhookSummary.allRegistered) {
        logger.info(`[OAuth] All required webhooks registered for ${shopDomain}`);
      } else {
        const missingTopics = webhookSummary.verification
          .filter((item) => !item.registered)
          .map((item) => item.key);
        logger.warn(
          `[OAuth] Webhook verification incomplete for ${shopDomain}. Missing: ${missingTopics.join(", ")}`
        );
      }
    } catch (whErr: any) {
      // Non-fatal — log but do not block the OAuth flow
      logger.error(`[OAuth] Webhook registration failed for ${shopDomain}:`, whErr.message);
    }

    const authContext = await auth.$context;
    const authSession = await authContext.internalAdapter.createSession(
      userId,
      {
        context: authContext,
        headers: new Headers({
          "user-agent": req.get("user-agent") || "",
        }),
      } as any
    );

    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("better-auth.session_token", authSession.token, {
      httpOnly: isProduction,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 60 * 60 * 24 * 7 * 1000, // 7 days in ms
      path: "/",
    });

    // Redirect merchant to dashboard
    res.redirect(`${env.FRONTEND_DOMAIN}/user/customer-management`);
  } catch (err: any) {
    logger.error("[OAuth] /callback error:", err.message);
    res.status(500).json({ error: "Failed to complete Shopify OAuth", details: err.message });
  }
});

export default shopifyRouter;
