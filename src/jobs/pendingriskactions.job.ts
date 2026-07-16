import { and, eq, lte } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import { orders, pendingRiskActions, users } from "@/schema/schema";
import { decrypt } from "@/service/encryption.service";
import { isShopifyTokenExpired, attemptTokenMigration } from "@/utils/shopify-token.util";
import { holdOrderFulfillment, cancelShopifyOrder } from "@/service/orderaction.service";
import { emitPendingActionUpdate } from "@/service/notificationsocket.service";
import { logger } from "@/utils/logger.util";
import type { IO } from "@/types/socket.types";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — plenty of precision for hour-granularity delays

/**
 * Executes one due pending action. Re-resolves the store's access token
 * fresh (not from whenever it was scheduled) since a delay can span many
 * hours — long enough for a token to genuinely expire in between, the same
 * class of bug fixed elsewhere for the reactive per-request paths.
 */
const markStatus = async (
  io: IO,
  action: typeof pendingRiskActions.$inferSelect,
  newStatus: "executed" | "failed",
  extra: Partial<typeof pendingRiskActions.$inferInsert> = {}
): Promise<void> => {
  await database
    .update(pendingRiskActions)
    .set({ status: newStatus, updatedAt: new Date(), ...extra })
    .where(eq(pendingRiskActions.id, action.id));
  emitPendingActionUpdate(io, action.storeId, { id: action.id, status: newStatus });
};

const executePendingAction = async (
  io: IO,
  action: typeof pendingRiskActions.$inferSelect
): Promise<void> => {
  const [store] = await database.select().from(users).where(eq(users.id, action.storeId));

  if (!store?.shopify_access_token || !store.shopify_url) {
    logger.error(`[PendingRiskAction] Missing store/token for action ${action.id}, marking failed.`);
    await markStatus(io, action, "failed");
    return;
  }

  let accessToken = decrypt(store.shopify_access_token);
  const storeUrl = store.shopify_url.startsWith("http") ? store.shopify_url : `https://${store.shopify_url}`;

  if (isShopifyTokenExpired(store.shopify_token_expires_at)) {
    const migrated = await attemptTokenMigration({
      shopDomain: storeUrl,
      encryptedToken: store.shopify_access_token,
      userId: store.id,
      expiresAt: store.shopify_token_expires_at,
    });
    if (!migrated) {
      logger.error(
        `[PendingRiskAction] Token expired and could not be renewed for store ${store.id}, marking failed.`
      );
      await markStatus(io, action, "failed");
      return;
    }
    accessToken = migrated.accessToken;
  }

  try {
    if (action.actionType === "hold") {
      await holdOrderFulfillment({
        storeUrl,
        accessToken,
        gOrderId: action.orderId,
        reasons: action.reasons ?? [],
      });
    } else {
      await cancelShopifyOrder({ storeUrl, accessToken, gOrderId: action.orderId });
      await database.update(orders).set({ autoCancel: true }).where(eq(orders.id, action.orderId));
    }

    await markStatus(io, action, "executed", { executedAt: new Date() });

    logger.info(`[PendingRiskAction] Executed ${action.actionType} for order ${action.orderId}`);
  } catch (err: any) {
    logger.error(
      `[PendingRiskAction] Failed to execute ${action.actionType} for order ${action.orderId}: ${err.message}`
    );
    await markStatus(io, action, "failed");
  }
};

const checkAndExecuteDuePendingActions = async (io: IO): Promise<void> => {
  const due = await database
    .select()
    .from(pendingRiskActions)
    .where(and(eq(pendingRiskActions.status, "pending"), lte(pendingRiskActions.scheduledFor, new Date())));

  for (const action of due) {
    await executePendingAction(io, action);
  }
};

/** Starts the interval loop — called once from server.ts at startup. */
export const startPendingRiskActionsScheduler = (io: IO): void => {
  setInterval(() => {
    checkAndExecuteDuePendingActions(io).catch((err) =>
      logger.error(`[PendingRiskAction] Scheduler tick failed: ${err.message}`)
    );
  }, CHECK_INTERVAL_MS);

  logger.info(
    `[PendingRiskAction] Scheduler started, checking every ${CHECK_INTERVAL_MS / 1000}s.`
  );
};
