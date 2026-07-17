import { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import { customers, settings, notifications, orders, pendingRiskActions, webhookEvents } from "@/schema/schema";
import { calculateRiskyOrders } from "@/service/risk.service";
import {
  highRiskOrderNotificationTemplate,
  customerOrderReviewEmailTemplate,
} from "@/utils/sendgrid.util";
import { sendEmail } from "@/configs/brevo.config";
import { createId } from "@paralleldrive/cuid2";
import { decrypt } from "@/service/encryption.service";
import { env } from "@/utils/env.util";
import {
  isShopifyTokenExpired,
  attemptTokenMigration,
} from "@/utils/shopify-token.util";
import { emitNewNotification } from "@/service/notificationsocket.service";
import { holdOrderFulfillment, cancelShopifyOrder } from "@/service/orderaction.service";
import { generateJwt } from "@/utils/jwt.util";
import type { IO } from "@/types/socket.types";

/**
 * The actual webhook handler acknowledges Shopify immediately (see
 * ordersCreateWebhook below) — everything that follows runs afterward, in a
 * detached async call. Nothing here can report failure via HTTP status
 * anymore since the response has already been sent; every branch that used
 * to `res.status(...).send(...)` and return now just logs and returns.
 */
const processOrderCreate = async (
  order: any,
  customerEmail: string,
  shopDomain: string,
  io: IO | undefined
): Promise<void> => {
  try {
    // 1. Resolve Store & Auth
    const store = await database.query.users.findFirst({
      where: (u, { or, eq }) => or(
        eq(u.shopify_url, `https://${shopDomain}`),
        eq(u.shopify_url, shopDomain)
      ),
    });

    if (!store) {
      // Previously a 404 that told Shopify to retry — now that the response
      // has already gone out, there's no way to signal Shopify from here.
      // Retrying wouldn't fix this anyway (it means our DB is out of sync,
      // not a transient failure), so a log is the correct outcome.
      console.error(`❌ Store ${shopDomain} not found in DB.`);
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
        // Opt-in, not opt-out — matches the privacy policy's "merchant
        // chooses whether to enable automation" claim. Existing stores'
        // rows are untouched by this default (defaults only apply on
        // insert of a new row with no explicit value).
        autoHoldRiskyOrders: false,
        primaryAction: "hold",
        notificationEmail: store.email,
        updatedAt: new Date(),
      } as any).returning();
      storeSettings = newSettingsRecord as any;
    }

    // 3. Resolve Customer (Upsert)
    //
    // Previously a select-by-(email, storeId) then plain INSERT if not
    // found — if that lookup missed for any reason (case-sensitive email
    // mismatch against however the customer-sync path stored it, a stale
    // storeId, etc.) while a row already existed under this same Shopify
    // gid, the INSERT collided on the primary key and crashed the whole
    // webhook with an unhandled unique-violation, blocking every
    // downstream risk/automation step. Upserting directly on customers.id
    // (matching the pattern in getcustomerforstore.controller.ts) makes
    // this resilient regardless of why a prior lookup might miss, without
    // needing a separate existence check at all.
    const shopifyId = order.customer?.id
      ? (String(order.customer.id).startsWith("gid://") ? order.customer.id : `gid://shopify/Customer/${order.customer.id}`)
      : `gid://shopify/Customer/${createId()}`;

    const customerName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || customerEmail.split("@")[0];

    const [customerRecord] = await database
      .insert(customers)
      .values({
        id: shopifyId,
        storeId,
        email: customerEmail,
        name: customerName,
        totalOrders: order.customer?.orders_count || 1,
        totalRefunded: "0.00",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: customers.id,
        set: {
          // Deliberately excludes totalRefunded — that's tracked via the
          // refunds webhook and risk calculation, this upsert's job is
          // just to keep identity fields current, not reset accounting
          // data an existing customer already has.
          storeId,
          email: customerEmail,
          name: customerName,
          totalOrders: order.customer?.orders_count || 1,
          updatedAt: new Date(),
        },
      })
      .returning();

    const customerId = customerRecord.id.startsWith("gid://") ? customerRecord.id : `gid://shopify/Customer/${customerRecord.id}`;

    // 4. Run Risk Analysis
    if (!storeAccessToken) {
      console.error(`❌ Missing access token for ${shopDomain} — cannot run risk analysis for order ${order.name}.`);
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
    //
    // Gating, per the privacy policy's opt-in/delay/manual-override claims:
    // - Hold only auto-fires when the merchant has explicitly turned on
    //   autoHoldRiskyOrders — primaryAction === "hold" alone used to fire
    //   this unconditionally, which is what made the policy inaccurate.
    // - auto_cancel is already an explicit opt-in (the merchant picked it
    //   from the Primary Action dropdown), so no extra toggle is needed
    //   there.
    // - If primaryAction is "hold" but autoHoldRiskyOrders is false, nothing
    //   automatic happens here at all — the order is already flagged=true
    //   (calculateRiskyOrders, above) and already gets the notification
    //   below, which is the "flagged/pending record staff can see" the
    //   policy describes, with zero automated Shopify-side action taken.
    let automationAction: "hold" | "auto_cancel" | null = null;
    if (highRiskOrder) {
      const gOrderId = String(order.id).startsWith("gid://")
        ? String(order.id)
        : `gid://shopify/Order/${order.id}`;

      const shouldHold =
        storeSettings?.primaryAction === "hold" &&
        storeSettings?.autoHoldRiskyOrders === true;
      const shouldAutoCancel = storeSettings?.primaryAction === "auto_cancel";

      if (shouldHold || shouldAutoCancel) {
        automationAction = shouldHold ? "hold" : "auto_cancel";
        const delayHours = Number(storeSettings?.actionDelayHours ?? 0);

        if (delayHours > 0) {
          // Defer instead of firing immediately — gives staff (via the new
          // cancel-pending-action endpoint) and the customer (via the
          // waiver/contest page) a real window to intervene before this
          // reaches Shopify.
          const scheduledFor = new Date(Date.now() + delayHours * 60 * 60 * 1000);
          await database.insert(pendingRiskActions).values({
            id: createId(),
            storeId,
            orderId: gOrderId,
            customerId: customerRecord.id,
            actionType: automationAction,
            status: "pending",
            reasons: highRiskOrder.reasons,
            scheduledFor,
          });
          console.log(
            `⏳ Deferred ${automationAction} for Order ${order.id} until ${scheduledFor.toISOString()}`
          );
        } else if (automationAction === "hold") {
          try {
            console.log(`⏸️ Holding fulfillment for Order ${order.id}`);
            await holdOrderFulfillment({
              storeUrl,
              accessToken: storeAccessToken,
              gOrderId,
              reasons: highRiskOrder.reasons,
            });
          } catch (e: any) {
            console.error("Fulfillment Hold Error:", e.response?.data || e.message);
          }
        } else {
          try {
            console.log(`⛔️ Cancelling Order ${order.id}`);
            await cancelShopifyOrder({ storeUrl, accessToken: storeAccessToken, gOrderId });
            await database.update(orders).set({ autoCancel: true }).where(eq(orders.id, gOrderId));
          } catch (e: any) {
            console.error("Cancellation Error:", e.response?.data || e.message);
          }
        }
      }
    }

    // 6. Alert Notifications
    if (highRiskOrder) {
      const orderDetails = order.line_items
        ?.map((item: any) => `${item.title} (x${item.quantity})`)
        .join("\n");

      const recommendedAction =
        automationAction === "hold"
          ? "Fulfillment Hold (Automatic)"
          : automationAction === "auto_cancel"
          ? "Automatic Cancellation"
          : "Flagged for Manual Review (no automated action taken)";

      // Signed so only this specific order's customer can view/contest it —
      // not guessable/enumerable by changing the order id in the URL.
      const waiverToken = generateJwt({ orderId: String(order.id), storeId }, "30d");
      const waiverLink = `${env.FRONTEND_DOMAIN}/waiver/${order.id}?token=${waiverToken}`;

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
        waiverLink,
      });

      // Merchant's own alert email respects their configured minimum order
      // value (default 0 — every high-risk order, same as before this
      // setting existed) so stores that get flooded with small flagged
      // orders can dial email volume down without losing in-app visibility
      // (toast/TitleBar/notifications list still fire regardless).
      const emailAlertThreshold = Number(storeSettings?.emailAlertMinOrderValue ?? 0);
      const orderValue = Number(highRiskOrder.totalAmount ?? 0);

      if (storeSettings?.emailNotificationsEnabled && orderValue >= emailAlertThreshold) {
        await sendEmail({
          to: storeSettings.notificationEmail || store.email,
          subject: `High Risk Alert: ${order.name}`,
          htmlContent: storeEmailHtml,
        }).catch((e) => console.error("Store email error:", e.message));
      }

      // Customer-facing copy — the waiver link was previously only ever
      // sent to the merchant (via storeEmailHtml above), which meant the
      // customer had no way to even find out a screening happened, let
      // alone contest it.
      if (storeSettings?.includeWavierLink && customerEmail) {
        const customerEmailHtml = customerOrderReviewEmailTemplate({
          orderName: order.name,
          storeName: store.name || shopDomain,
          waiverLink,
        });

        await sendEmail({
          to: customerEmail,
          subject: `A quick review is needed for your order ${order.name}`,
          htmlContent: customerEmailHtml,
        }).catch((e) => console.error("Customer waiver email error:", e.message));
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

      try {
        const [insertedNotification] = await database
          .insert(notifications)
          .values({
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
          } as any)
          .returning();

        emitNewNotification(io, storeId, insertedNotification);
      } catch (e: any) {
        console.error("Notification Error:", e.message);
      }
    }

    console.log(`✅ Finished processing order ${order.name}`);
  } catch (err: any) {
    // Shopify already has its 200 — this can only be logged, not reported.
    console.error(`Webhook Fatal (async) for order ${order?.name}:`, err.message);
  }
};

export const ordersCreateWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
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

  // Idempotency guard — Shopify redelivers a webhook whenever it doesn't
  // get a fast 200 (or on transient failures), and this key is permanent
  // (no time window) since orders/create logically fires once per order;
  // a late duplicate should still be skipped, not reprocessed once some
  // window expires.
  const dedupeKey = `${shopDomain}:orders/create:${order.id}`;
  let isDuplicate = false;
  try {
    const inserted = await database
      .insert(webhookEvents)
      .values({ key: dedupeKey, topic: "orders/create" })
      .onConflictDoNothing()
      .returning({ key: webhookEvents.key });

    isDuplicate = inserted.length === 0;
  } catch (err: any) {
    // Fail OPEN, not closed: if the dedup table/query itself is broken
    // (e.g. webhook_events doesn't exist yet — see dbpush), the correct
    // behavior is to lose dedup protection temporarily, not to silently
    // stop processing every single order. A missing safety net is far
    // less damaging than a total automation outage.
    console.error(
      `CRITICAL: Webhook dedup check failed for ${dedupeKey} — proceeding WITHOUT duplicate protection: ${err.message}`
    );
    isDuplicate = false;
  }

  if (isDuplicate) {
    console.log(`↩️ Duplicate webhook delivery for ${dedupeKey} — already processed, skipping.`);
    res.status(200).send("✅ Duplicate (already processed)");
    return;
  }

  // Acknowledge immediately — Shopify only needs confirmation the webhook
  // was received within ~5s, not that processing finished. Everything
  // heavy (store/token resolution, risk analysis, hold/cancel, emails)
  // used to run before this response went out, regularly taking 7-9s and
  // triggering Shopify's own retry-on-timeout, which reprocessed the same
  // order multiple times.
  res.status(200).send("✅ Received");

  void processOrderCreate(order, customerEmail, shopDomain, req.io);
};
