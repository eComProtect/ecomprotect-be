import { Request, Response } from "express";
import { database } from "@/configs/connection.config";
import { customers, notifications, orders } from "@/schema/schema";
import { eq } from "drizzle-orm";
import { logActivity } from "@/service/logactivity.service";
import { sendPushToStore } from "@/service/push.service";
import { emitNewNotification } from "@/service/notificationsocket.service";
import status from "http-status";

export const refundsCreateWebhook = async (req: Request, res: Response) => {
  try {
    const refund = req.body; // Shopify sends refund + order details here
    const orderId = `gid://shopify/Order/${refund.order_id}`;

    // Fetch order & customer
    const [orderRecord] = await database
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));

    if (!orderRecord) {
      res.status(status.BAD_REQUEST).send("Order not found");
      return;
    }

    if (!orderRecord.customerId) {
      res.status(status.BAD_REQUEST).send("Order has no linked customerId");
      return;
    }

    const [customerRecord] = await database
      .select()
      .from(customers)
      .where(eq(customers.id, orderRecord.customerId));

    // Build notification payload
    const notificationData = {
      storeId: customerRecord?.storeId ?? "",
      customerId: customerRecord?.id ?? null,
      type: "REFUND",
      title: `Refund detected for ${orderRecord.name}`,
      message: `${customerRecord?.name || "Customer"} refunded order ${orderRecord.name
        }`,
      meta: {
        orderId: orderRecord.id,
        orderName: orderRecord.name,
        totalAmount: orderRecord.totalAmount?.toString(),
        currency: orderRecord.currency,
        customerEmail: customerRecord?.email,
        ip: customerRecord?.ip,
        location: "London, UK", // 👉 you'd enrich this via IP lookup (like ipinfo API)
        riskLevel: `${customerRecord?.riskLevel || "N/A"}%`,
        detectedOn: new Date().toISOString(),
      },
    };

    await logActivity({
      action: "REFUND",
      for: "customer",
      orderId,
      customerId: customerRecord?.id ?? null,
      storeId: customerRecord?.storeId ?? null,
      meta: notificationData,
    });

    const [inserted] = await database
      .insert(notifications)
      .values(notificationData)
      .returning();

    if (inserted?.id && customerRecord?.storeId) {
      sendPushToStore(customerRecord.storeId, {
        title: notificationData.title,
        message: notificationData.message,
        notificationId: inserted.id,
      }).catch(() => { });

      emitNewNotification(req.io, customerRecord.storeId, inserted);
    }

    res.status(status.OK).send("Refund webhook processed");
  } catch (error: any) {
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .send("Failed to process refund webhook");
  }
};
