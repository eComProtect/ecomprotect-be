import { database } from "@/configs/connection.config";
import { settings } from "@/schema/schema";
import { calculateRiskyOrders } from "@/service/risk.service";
import { Request, Response } from "express";
import status from "http-status";
import { eq } from "drizzle-orm";
import { decrypt } from "@/service/encryption.service";
import {
  isShopifyTokenExpired,
  attemptTokenMigration,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

export const getRiskyOrders = async (req: Request, res: Response) => {
  try {
    const storeId = req.user?.id;
    const customerId = req.query.customerId as string;
    const storeUrl = req.user?.shopify_url;
    const getAccessToken = req.user?.shopify_access_token;
    let accessToken = getAccessToken ? decrypt(getAccessToken) : null;

    if (isShopifyTokenExpired(req.user?.shopify_token_expires_at)) {
      const migrated = await attemptTokenMigration({
        shopDomain: storeUrl ?? "",
        encryptedToken: getAccessToken ?? "",
        userId: storeId ?? "",
        expiresAt: req.user?.shopify_token_expires_at,
      });
      if (!migrated) {
        res.status(status.UNAUTHORIZED).json({
          ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
          reAuthUrl: shopifyReAuthUrl(storeUrl ?? ""),
        });
        return;
      }
      accessToken = migrated.accessToken;
    }

    if (!storeId || !customerId || !storeUrl || !accessToken) {
      res.status(status.BAD_REQUEST).json({
        message: "Store ID, Customer ID, Shopify URL, and Token are required",
      });
      return;
    }

    const [orderSettings] = await database
      .select({
        primaryAction: settings.primaryAction,
        requireESignature: settings.requireESignature,
        forceCourierSignedDelivery: settings.forceCourierSignedDelivery,
        photoOnDelivery: settings.photoOnDelivery,
        sendCancellationEmail: settings.sendCancellationEmail,
      })
      .from(settings)
      .where(eq(settings.storeId, storeId));

    const data = await calculateRiskyOrders({
      storeId,
      customerId,
      storeUrl,
      accessToken,
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(status.OK).json({
      id: data.customer.id,
      email: data.customer.email,
      orders: data.orders,
      ...orderSettings,
    });
  } catch (error: any) {
    console.error(error.response?.data || error.message || error);
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: error.message || "Internal server error" });
  }
};
