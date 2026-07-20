import { desc, eq } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import { notifications, customers } from "@/schema/schema";
import { logger } from "@/utils/logger.util";
import { Request, Response } from "express";
import status from "http-status";
import { resolveStoreRow } from "@/middlewares/auth.middleware";

export const getNotificationController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(status.UNAUTHORIZED).json({ message: "Unauthorized" });
      return;
    }

    // Notifications belong to the store (owner row), not whichever staff
    // member is asking.
    const store = await resolveStoreRow(req.user);
    const storeId = store?.id;
    if (!storeId) {
      res.status(status.UNAUTHORIZED).json({ message: "Unauthorized" });
      return;
    }

    const notifs = await database
      .select({
        notification: notifications,
        customerName: customers.name,
      })
      .from(notifications)
      .leftJoin(customers, eq(notifications.customerId, customers.id))
      .where(eq(notifications.storeId, storeId))
      .orderBy(desc(notifications.createdAt));

    const data = notifs.map((row) => {
      return {
        ...row.notification,
        customerName: row.customerName ?? null,
      };
    });

    res.status(status.OK).json({ data });
  } catch (error: any) {
    logger.error("Error in getNotificationController:", error);
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Internal Server Error" });
  }
};
