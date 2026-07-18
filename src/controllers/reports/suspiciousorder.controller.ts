import { database } from "@/configs/connection.config";
import { customers, orders } from "@/schema/schema";
import { between, eq, and } from "drizzle-orm";
import { Request, Response } from "express";
import { resolveStoreRow } from "@/middlewares/auth.middleware";

// Suspicious Orders Summary
export const getSuspiciousOrdersSummary = async (
  req: Request,
  res: Response,
) => {
  try {
    const { startDate, endDate } = req.query;
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Orders belong to the store (owner row), not whichever staff member
    // is asking.
    const store = await resolveStoreRow(req.user);
    const storeId = store?.id;
    if (!storeId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const end = endDate ? new Date(endDate as string) : new Date();
    const start = startDate
      ? new Date(startDate as string)
      : new Date(new Date().setDate(end.getDate() - 30));

    const allOrders = await database
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        flagged: orders.flagged,
        autoCancel: orders.autoCancel,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .where(
        and(
          eq(customers.storeId, storeId),
          between(orders.createdAt, start, end),
        ),
      );

    const totalOrders = allOrders.length;

    const flaggedOrders = allOrders.filter((o) => o.flagged).length;

    const autoCancelled = allOrders.filter((o) => o.autoCancel).length;

    // totalAmount comes back as a numeric/decimal string from Postgres — summing
    // floats accumulates rounding drift (e.g. 8277.160000000002), so round once
    // to the nearest penny after the sum rather than per-item.
    const preventedValue =
      Math.round(
        allOrders
          .filter((o) => o.flagged || o.autoCancel)
          .reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0) * 100
      ) / 100;

    // Chart data (group by day)
    const flaggedByDay: Record<string, number> = {};
    allOrders
      .filter((o) => o.flagged)
      .forEach((o) => {
        const day = o?.createdAt?.toISOString().split("T")[0];
        if (day) {
          flaggedByDay[day] = (flaggedByDay[day] || 0) + 1;
        }
      });

    res.json({
      range: { start, end },
      metrics: {
        totalOrders,
        flaggedOrders,
        autoCancelled,
        preventedValue,
      },
      chartData: Object.entries(flaggedByDay).map(([date, count]) => ({
        date,
        count,
      })),
    });

    return;
  } catch (err) {
    console.error("Error generating Suspicious Orders Summary:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
};
