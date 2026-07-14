import { Request, Response } from "express";
import status from "http-status";
import { database } from "@/configs/connection.config";
import { pushSubscriptions } from "@/schema/schema";
import { eq, and } from "drizzle-orm";
import { getVapidPublicKey } from "@/service/push.service";
import { logger } from "@/utils/logger.util";
import {
  findUserByShopDomain,
  resolveRequestUser,
  resolveStoreRow,
} from "@/middlewares/auth.middleware";

export const getVapidPublicKeyController = (_req: Request, res: Response) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(status.SERVICE_UNAVAILABLE).json({
      message: "Push notifications are not configured",
    });
    return;
  }
  res.json({ vapidPublicKey: key });
};

/**
 * Resolves the store this subscription belongs to. Prefers a real session
 * (dashboard usage, already authenticated) — falls back to an explicit `shop`
 * field when there isn't one, since the standalone /enable-notifications tab
 * (opened outside Shopify's iframe specifically to get a real permission
 * prompt) has no session of its own. Knowing a shop's domain is enough to
 * subscribe a browser to that store's push notifications and nothing more
 * sensitive, so this is a deliberately low bar — not the same trust level as
 * protectRoute.
 */
const resolveStoreForPushSubscription = async (
  req: Request
): Promise<{ id: string } | null> => {
  const sessionUser = await resolveRequestUser(req);
  if (sessionUser) {
    const store = await resolveStoreRow(sessionUser);
    if (store) return store;
  }

  const shop = req.body?.shop ?? req.query?.shop;
  if (typeof shop === "string" && shop.trim()) {
    const owner = await findUserByShopDomain(shop.trim().replace(/^https?:\/\//, ""));
    if (owner) return owner;
  }

  return null;
};

export const savePushSubscriptionController = async (
  req: Request,
  res: Response
) => {
  try {
    const store = await resolveStoreForPushSubscription(req);
    if (!store) {
      res.status(status.UNAUTHORIZED).json({
        message: "Could not identify a store for this subscription.",
      });
      return;
    }
    const storeId = store.id;

    const { endpoint, keys } = req.body as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(status.BAD_REQUEST).json({
        message: "Missing endpoint or keys (p256dh, auth)",
      });
      return;
    }

    const existing = await database
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.storeId, storeId),
          eq(pushSubscriptions.endpoint, endpoint)
        )
      );

    if (existing.length > 0) {
      res.status(status.OK).json({ message: "Subscription already saved" });
      return;
    }

    await database.insert(pushSubscriptions).values({
      storeId,
      endpoint,
      p256dhKey: keys.p256dh,
      authKey: keys.auth,
    });

    res.status(status.CREATED).json({ message: "Push subscription saved" });
  } catch (error) {
    logger.error("Error saving push subscription:", error);
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Failed to save push subscription" });
  }
};

/** GET /api/notifications/push-subscription/status — does this store have any active push subscriptions? */
export const getPushSubscriptionStatusController = async (
  req: Request,
  res: Response
) => {
  const storeId = req.user?.id;
  if (!storeId) {
    res.status(status.UNAUTHORIZED).json({ message: "Unauthorized" });
    return;
  }

  const subscriptions = await database
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.storeId, storeId));

  res.status(status.OK).json({ subscribed: subscriptions.length > 0 });
};
