import { Request, Response } from "express";
import axios from "axios";
import { database } from "@/configs/connection.config";
import { customers, settings, notifications } from "@/schema/schema";
// import { and, eq } from "drizzle-orm";
import { calculateRiskyOrders } from "@/service/risk.service";
import { highRiskOrderNotificationTemplate } from "@/utils/sendgrid.util";
import { sendEmail } from "@/configs/brevo.config";
import { createId } from "@paralleldrive/cuid2";
import { decrypt } from "@/service/encryption.service";
import { env } from "@/utils/env.util";
import {
  isShopifyTokenExpired,
  attemptTokenMigration,
} from "@/utils/shopify-token.util";

export const ordersCreateWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const order = req.body;
    const customerEmail = order.customer?.email;
    const shopDomain = req.headers["x-shopify-shop-domain"] as string;

    console.log(`📩 Webhook from ${shopDomain} | Order: ${order.name}`);

    if (!shopDomain) {
      res.status(400).send("Missing shop domain header");
      return;
    }

    if (!customerEmail) {
      console.log("Skipping webhook: No customer email found in order payload.");
      res.status(200).send("✅ Skipped (No Email)");
      return;
    }

    // 1. Resolve Store & Auth
    const store = await database.query.users.findFirst({
      where: (u, { or, eq }) => or(
        eq(u.shopify_url, `https://${shopDomain}`),
        eq(u.shopify_url, shopDomain)
      ),
    });

    if (!store) {
      console.error(`❌ Store ${shopDomain} not found in DB.`);
      res.status(404).send("Store not found");
      return;
    }

    const storeId = store.id;
    const storeUrl = store.shopify_url?.startsWith("http") ? store.shopify_url : `https://${store.shopify_url}`;
    let storeAccessToken = store.shopify_access_token ? decrypt(store.shopify_access_token) : null;

    if (storeAccessToken && isShopifyTokenExpired(store.shopify_token_expires_at)) {
      const migrated = await attemptTokenMigration({
        shopDomain: storeUrl,
        encryptedToken: store.shopify_access_token!,
        userId: storeId,
        expiresAt: store.shopify_token_expires_at,
      });
      storeAccessToken = migrated?.accessToken ?? null;
    }

    // 2. Resolve Settings
    let storeSettings = await database.query.settings.findFirst({
      where: (s, { eq }) => eq(s.storeId, storeId),
    });

    if (!storeSettings) {
      console.log(`⚙️ Initializing default settings for ${shopDomain}`);
      const [newSettingsRecord] = await database.insert(settings).values({
        storeId,
        autoHoldRiskyOrders: true,
        primaryAction: "hold",
        notificationEmail: store.email,
        updatedAt: new Date(),
      } as any).returning();
      storeSettings = newSettingsRecord as any;
    }

    // 3. Resolve Customer (Auto-Create if New)
    let customerRecord = await database.query.customers.findFirst({
      where: (c, { and, eq }) => and(
        eq(c.email, customerEmail),
        eq(c.storeId, storeId)
      ),
    });

    if (!customerRecord) {
      console.log(`👤 Creating record for new customer ${customerEmail}`);
      const shopifyId = order.customer?.id
        ? (String(order.customer.id).startsWith("gid://") ? order.customer.id : `gid://shopify/Customer/${order.customer.id}`)
        : `gid://shopify/Customer/${createId()}`;

      const [newCust] = await database.insert(customers).values({
        id: shopifyId,
        storeId,
        email: customerEmail,
        name: `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || customerEmail.split("@")[0],
        totalOrders: order.customer?.orders_count || 1,
        totalRefunded: "0.00",
        updatedAt: new Date(),
      }).returning();
      customerRecord = newCust;
    }

    const customerId = customerRecord.id.startsWith("gid://") ? customerRecord.id : `gid://shopify/Customer/${customerRecord.id}`;

    // 4. Run Risk Analysis
    if (!storeAccessToken) {
      console.error(`❌ Missing access token for ${shopDomain}`);
      res.status(500).send("Missing store access token");
      return;
    }

    const riskResult = await calculateRiskyOrders({
      storeId,
      customerId,
      storeUrl,
      accessToken: storeAccessToken,
    });

    const highRiskOrder = riskResult.orders.find((o) => o.flagged === true);

    console.log("Analysis Result:", {
      flagged: !!highRiskOrder,
      action: storeSettings?.primaryAction,
      automation: storeSettings?.autoHoldRiskyOrders,
    });

    // 5. Automation Actions
    if (highRiskOrder) {
      // Normalise order ID to GID format once
      const gOrderId = String(order.id).startsWith("gid://")
        ? String(order.id)
        : `gid://shopify/Order/${order.id}`;

      if (storeSettings?.primaryAction === "hold") {
        try {
          console.log(`⏸️ Holding fulfillment for Order ${order.id}`);

          // GraphQL: fetch open fulfillment orders for this order
          const foGqlQuery = `
            query getFulfillmentOrders($orderId: ID!) {
              order(id: $orderId) {
                fulfillmentOrders(first: 10) {
                  nodes {
                    id
                    status
                  }
                }
              }
            }
          `;
          const foRes = await axios.post(
            `${storeUrl}/admin/api/2025-07/graphql.json`,
            { query: foGqlQuery, variables: { orderId: gOrderId } },
            { headers: { "X-Shopify-Access-Token": storeAccessToken, "Content-Type": "application/json" } }
          );

          const foNodes: Array<{ id: string; status: string }> =
            foRes.data?.data?.order?.fulfillmentOrders?.nodes ?? [];
          const openFOs = foNodes.filter((fo) => fo.status === "OPEN");

          // GraphQL: place a hold on each open fulfillment order
          const holdMutation = `
            mutation fulfillmentOrderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
              fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
                userErrors { message }
              }
            }
          `;
          for (const fo of openFOs) {
            const holdRes = await axios.post(
              `${storeUrl}/admin/api/2025-07/graphql.json`,
              {
                query: holdMutation,
                variables: {
                  id: fo.id,
                  fulfillmentHold: {
                    reason: "OTHER",
                    reasonNotes: `Fulfillment held by eComProtect. Identified risk factors: ${highRiskOrder.reasons.join("; ")}. Please perform a manual review before fulfilling.`,
                    notifyMerchant: false,
                  },
                },
              },
              { headers: { "X-Shopify-Access-Token": storeAccessToken, "Content-Type": "application/json" } }
            );
            const holdErrors = holdRes.data?.data?.fulfillmentOrderHold?.userErrors ?? [];
            if (holdErrors.length > 0) {
              console.error(`Hold errors for FO ${fo.id}:`, holdErrors);
            } else {
              console.log(`✅ Hold applied to FO ${fo.id}`);
            }
          }

          // GraphQL: update order note for visibility in the Shopify dashboard
          const orderUpdateMutation = `
            mutation orderUpdate($input: OrderInput!) {
              orderUpdate(input: $input) {
                order { id }
                userErrors { message }
              }
            }
          `;
          await axios.post(
            `${storeUrl}/admin/api/2025-07/graphql.json`,
            {
              query: orderUpdateMutation,
              variables: {
                input: {
                  id: gOrderId,
                  note: `eComProtect: Fulfillment on hold. Risk factors: ${highRiskOrder.reasons.join("; ")}`,
                },
              },
            },
            { headers: { "X-Shopify-Access-Token": storeAccessToken, "Content-Type": "application/json" } }
          );
          console.log(`✅ Main Order Note updated for Order ${order.id}`);
        } catch (e: any) {
          console.error("Fulfillment Hold Error:", e.response?.data || e.message);
        }
      } else if (storeSettings?.primaryAction === "auto_cancel") {
        try {
          console.log(`⛔️ Cancelling Order ${order.id}`);

          // GraphQL: cancel the order
          const cancelMutation = `
            mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean!) {
              orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer) {
                orderCancelUserErrors { message }
              }
            }
          `;
          const cancelRes = await axios.post(
            `${storeUrl}/admin/api/2025-07/graphql.json`,
            {
              query: cancelMutation,
              variables: {
                orderId: gOrderId,
                reason: "FRAUD",
                notifyCustomer: true,
              },
            },
            { headers: { "X-Shopify-Access-Token": storeAccessToken, "Content-Type": "application/json" } }
          );
          const cancelErrors = cancelRes.data?.data?.orderCancel?.orderCancelUserErrors ?? [];
          if (cancelErrors.length > 0) {
            console.error("Cancel errors:", cancelErrors);
          } else {
            console.log("✅ Order cancelled.");
          }
        } catch (e: any) {
          console.error("Cancellation Error:", e.response?.data || e.message);
        }
      }
    }

    // 6. Alert Notifications
    if (highRiskOrder) {
      const orderDetails = order.line_items
        ?.map((item: any) => `${item.title} (x${item.quantity})`)
        .join("\n");

      const recommendedAction =
        storeSettings?.primaryAction === "hold"
          ? "Fulfillment Hold (Manual Review Required)"
          : "Automatic Cancellation";

      const storeEmailHtml = highRiskOrderNotificationTemplate({
        adminName: store.name || "Admin",
        orderName: order.name,
        customerEmail: customerEmail,
        riskReasons: highRiskOrder.reasons,
        orderLink: `${storeUrl}/admin/orders/${order.id}`,
        includeOrderDetails: storeSettings?.includeOrderDetails ?? true,
        includeReasonForFlag: storeSettings?.includeReasonForFlag ?? true,
        includeRecommendedAction:
          storeSettings?.includeRecommendedAction ?? true,
        includeWavierLink: storeSettings?.includeWavierLink ?? false,
        orderDetails: orderDetails,
        recommendedAction,
        waiverLink: `${env.FRONTEND_DOMAIN}/waiver/${order.id}`,
      });

      if (storeSettings?.emailNotificationsEnabled) {
        await sendEmail({
          to: storeSettings.notificationEmail || store.email,
          subject: `High Risk Alert: ${order.name}`,
          htmlContent: storeEmailHtml,
        }).catch((e) => console.error("Store email error:", e.message));
      }

      const superAdminEmail = env.ADMIN_EMAIL;
      const storeNotificationEmail = storeSettings?.notificationEmail || store.email;

      if (
        superAdminEmail &&
        superAdminEmail.toLowerCase() !== storeNotificationEmail?.toLowerCase()
      ) {
        const superAdminEmailHtml = highRiskOrderNotificationTemplate({
          adminName: "Super Admin",
          orderName: order.name,
          customerEmail: customerEmail,
          riskReasons: [
            `Store: ${store.name || store.shopify_url || shopDomain}`,
            ...highRiskOrder.reasons,
          ],
          orderLink: `${storeUrl}/admin/orders/${order.id}`,
          includeOrderDetails: true,
          includeReasonForFlag: true,
          includeRecommendedAction: true,
          includeWavierLink: false,
          orderDetails,
          recommendedAction,
        });

        await sendEmail({
          to: superAdminEmail,
          subject: `High Risk Alert: ${order.name} - ${
            store.name || store.shopify_url || shopDomain
          }`,
          htmlContent: superAdminEmailHtml,
        }).catch((e) => console.error("Super admin email error:", e.message));
      }

      await database.insert(notifications).values({
        storeId,
        customerId: customerRecord.id,
        type: "HIGH_RISK_ORDER",
        title: `High Risk Order: ${order.name}`,
        message: `High risk detected for ${order.name}`,
        meta: {
          orderId: String(order.id),
          orderName: order.name,
          reasons: highRiskOrder.reasons,
        },
      } as any).catch((e) => console.error("Notification Error:", e.message));
    }

    res.status(200).send("✅ Success");
  } catch (err: any) {
    console.error("Webhook Fatal:", err.message);
    res.status(500).send("❌ Error");
  }
};
