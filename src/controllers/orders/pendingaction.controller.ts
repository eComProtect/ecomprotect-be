import { Request, Response } from "express";
import status from "http-status";
import { and, desc, eq } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import { pendingRiskActions, orders, customers } from "@/schema/schema";
import { resolveStoreRow } from "@/middlewares/auth.middleware";
import { emitPendingActionUpdate } from "@/service/notificationsocket.service";

/**
 * GET /api/order/pending-actions?includeHistory=true
 *
 * Defaults to pending-only (the dashboard's default view). Pass
 * includeHistory=true to also get executed/cancelled rows, for the audit
 * filter toggle.
 *
 * Joins order/customer to return a human-readable order number and
 * customer name — the raw pendingRiskActions row only has their ids.
 */
export const listPendingActions = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(status.UNAUTHORIZED).json({ message: "Authentication required." });
    return;
  }

  const store = await resolveStoreRow(req.user);
  if (!store) {
    res.status(status.UNAUTHORIZED).json({ message: "Authentication required." });
    return;
  }

  const includeHistory = req.query.includeHistory === "true";

  const rows = await database
    .select({
      id: pendingRiskActions.id,
      orderId: pendingRiskActions.orderId,
      orderName: orders.name,
      customerId: pendingRiskActions.customerId,
      customerName: customers.name,
      actionType: pendingRiskActions.actionType,
      status: pendingRiskActions.status,
      reasons: pendingRiskActions.reasons,
      scheduledFor: pendingRiskActions.scheduledFor,
      executedAt: pendingRiskActions.executedAt,
      createdAt: pendingRiskActions.createdAt,
    })
    .from(pendingRiskActions)
    .leftJoin(orders, eq(pendingRiskActions.orderId, orders.id))
    .leftJoin(customers, eq(pendingRiskActions.customerId, customers.id))
    .where(
      includeHistory
        ? eq(pendingRiskActions.storeId, store.id)
        : and(eq(pendingRiskActions.storeId, store.id), eq(pendingRiskActions.status, "pending"))
    )
    .orderBy(desc(pendingRiskActions.createdAt));

  res.status(status.OK).json({ data: rows });
};

/** POST /api/order/cancel-pending-action { pendingActionId } — staff override during the delay window. */
export const cancelPendingAction = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(status.UNAUTHORIZED).json({ message: "Authentication required." });
    return;
  }

  const { pendingActionId } = req.body ?? {};
  if (!pendingActionId) {
    res.status(status.BAD_REQUEST).json({ message: "pendingActionId is required." });
    return;
  }

  const store = await resolveStoreRow(req.user);
  if (!store) {
    res.status(status.UNAUTHORIZED).json({ message: "Authentication required." });
    return;
  }

  const [row] = await database
    .select()
    .from(pendingRiskActions)
    .where(eq(pendingRiskActions.id, pendingActionId));

  if (!row || row.storeId !== store.id) {
    res.status(status.NOT_FOUND).json({ message: "Pending action not found." });
    return;
  }

  if (row.status !== "pending") {
    res.status(status.BAD_REQUEST).json({
      message: `This action is no longer pending (status: ${row.status}).`,
    });
    return;
  }

  await database
    .update(pendingRiskActions)
    .set({ status: "cancelled_by_staff", updatedAt: new Date() })
    .where(eq(pendingRiskActions.id, pendingActionId));

  emitPendingActionUpdate(req.io, store.id, { id: pendingActionId, status: "cancelled_by_staff" });

  res.status(status.OK).json({ message: "Pending action cancelled." });
};
