import { Request, Response } from "express";
import status from "http-status";
import { and, desc, eq } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import { orders, pendingRiskActions, users, notifications } from "@/schema/schema";
import { verifyJwt } from "@/utils/jwt.util";
import { emitNewNotification, emitPendingActionUpdate } from "@/service/notificationsocket.service";
import { planHasFeature } from "@/utils/billing.util";

interface WaiverTokenPayload {
  orderId: string; // raw numeric Shopify order id, as used in the URL
  storeId: string;
}

/**
 * Public, token-gated — deliberately not behind protectRoute. The customer
 * has no account/session in this app; the signed token itself (bound to one
 * orderId + storeId, see order.webhook.ts) is what proves this is the
 * intended recipient rather than someone guessing order ids in the URL.
 */
const verifyWaiverToken = (
  rawOrderId: string,
  token: unknown
): WaiverTokenPayload | null => {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = verifyJwt<WaiverTokenPayload>(token);
    if (payload.orderId !== rawOrderId) return null;
    return payload;
  } catch {
    return null;
  }
};

const toGid = (rawOrderId: string) =>
  rawOrderId.startsWith("gid://") ? rawOrderId : `gid://shopify/Order/${rawOrderId}`;

/** GET /api/order/:orderId/waiver-info?token=... */
export const getWaiverInfo = async (req: Request, res: Response): Promise<void> => {
  const rawOrderId = req.params.orderId;
  const payload = verifyWaiverToken(rawOrderId, req.query.token);

  if (!payload) {
    res.status(status.UNAUTHORIZED).json({ message: "This link is invalid or has expired." });
    return;
  }

  const gOrderId = toGid(rawOrderId);

  const [orderRow] = await database.select().from(orders).where(eq(orders.id, gOrderId));
  if (!orderRow) {
    res.status(status.NOT_FOUND).json({ message: "Order not found." });
    return;
  }

  const [store] = await database
    .select({ name: users.name, shopify_url: users.shopify_url, package: users.package })
    .from(users)
    .where(eq(users.id, payload.storeId));

  // Waiver workflow is Shield-only — re-checked here (not just at the point
  // the link is generated/emailed) so a store that downgraded after this
  // link was already sent can't still have it honored.
  if (!planHasFeature(store?.package, "waiverWorkflow")) {
    res.status(status.FORBIDDEN).json({
      message: "This review link is no longer available for this store.",
    });
    return;
  }

  const [pending] = await database
    .select()
    .from(pendingRiskActions)
    .where(
      and(eq(pendingRiskActions.orderId, gOrderId), eq(pendingRiskActions.storeId, payload.storeId))
    )
    .orderBy(desc(pendingRiskActions.createdAt))
    .limit(1);

  res.status(status.OK).json({
    orderName: orderRow.name,
    storeName: store?.name || store?.shopify_url || "the merchant",
    reasons: pending?.reasons ?? [],
    pendingStatus: pending?.status ?? null,
    scheduledFor: pending?.scheduledFor ?? null,
  });
};

/** POST /api/order/:orderId/contest { token, explanation } */
export const contestOrder = async (req: Request, res: Response): Promise<void> => {
  const rawOrderId = req.params.orderId;
  const { token, explanation } = req.body ?? {};
  const payload = verifyWaiverToken(rawOrderId, token);

  if (!payload) {
    res.status(status.UNAUTHORIZED).json({ message: "This link is invalid or has expired." });
    return;
  }

  if (typeof explanation !== "string" || !explanation.trim()) {
    res.status(status.BAD_REQUEST).json({ message: "Please provide a brief explanation." });
    return;
  }

  const [contestStore] = await database
    .select({ package: users.package })
    .from(users)
    .where(eq(users.id, payload.storeId));

  if (!planHasFeature(contestStore?.package, "waiverWorkflow")) {
    res.status(status.FORBIDDEN).json({
      message: "This review link is no longer available for this store.",
    });
    return;
  }

  const gOrderId = toGid(rawOrderId);
  const trimmedExplanation = explanation.trim().slice(0, 1000);

  const [orderRow] = await database.select().from(orders).where(eq(orders.id, gOrderId));

  // Pause any still-pending automated action — a contest is exactly the kind
  // of human intervention the delay window exists to allow for.
  const cancelledActions = await database
    .update(pendingRiskActions)
    .set({ status: "cancelled_by_contest", updatedAt: new Date() })
    .where(
      and(
        eq(pendingRiskActions.orderId, gOrderId),
        eq(pendingRiskActions.storeId, payload.storeId),
        eq(pendingRiskActions.status, "pending")
      )
    )
    .returning({ id: pendingRiskActions.id });

  for (const action of cancelledActions) {
    emitPendingActionUpdate(req.io, payload.storeId, { id: action.id, status: "cancelled_by_contest" });
  }

  const [insertedNotification] = await database
    .insert(notifications)
    .values({
      storeId: payload.storeId,
      customerId: orderRow?.customerId ?? null,
      type: "ORDER_CONTESTED",
      title: `Customer contested order ${orderRow?.name ?? rawOrderId}`,
      message: trimmedExplanation,
      meta: {
        orderId: rawOrderId,
        orderName: orderRow?.name,
      },
    } as any)
    .returning();

  emitNewNotification(req.io, payload.storeId, insertedNotification);

  res.status(status.OK).json({ message: "Your response has been submitted for review." });
};
