import { database } from "@/configs/connection.config";
import { settings } from "@/schema/schema";
import { calculateRiskyOrders } from "@/service/risk.service";
import { Request, Response } from "express";
import status from "http-status";
import { eq } from "drizzle-orm";
import {
  resolveStoreShopifyAccess,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

export const getRiskyOrders = async (req: Request, res: Response) => {
  try {
    const customerId = req.query.customerId as string;

    if (!req.user) {
      res.status(status.UNAUTHORIZED).json({ message: "Not authenticated" });
      return;
    }

    const resolved = await resolveStoreShopifyAccess(req.user);
    if (!resolved) {
      res.status(status.UNAUTHORIZED).json({
        ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
        reAuthUrl: shopifyReAuthUrl(req.user.shopify_url ?? ""),
      });
      return;
    }
    const { store, accessToken } = resolved;
    const storeId = store.id;
    const storeUrl = store.shopify_url!;

    if (!customerId) {
      res.status(status.BAD_REQUEST).json({
        message: "Customer ID is required",
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
