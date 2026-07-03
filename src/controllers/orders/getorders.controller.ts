import { database } from "@/configs/connection.config";
import axios from "axios";
import { Request, Response } from "express";
import status from "http-status";
import { eq } from "drizzle-orm";
import { fulfillmentOrders, orderItems, orders } from "@/schema/schema";
import { decrypt } from "@/service/encryption.service";
import {
  isShopifyTokenExpired,
  attemptTokenMigration,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

/**
 *
 * This is to fetch all the orders from the Shopfiy
 */
export const getOrders = async (req: Request, res: Response) => {
  try {
    const data = req.user;

    const storeUrl = data?.shopify_url;
    const getAccessToken = data?.shopify_access_token;
    let accessToken = getAccessToken ? decrypt(getAccessToken) : null;

    if (isShopifyTokenExpired(data?.shopify_token_expires_at)) {
      const migrated = await attemptTokenMigration({
        shopDomain: storeUrl ?? "",
        encryptedToken: getAccessToken ?? "",
        userId: data?.id ?? "",
      });
      if (!migrated) {
        res.status(status.UNAUTHORIZED).json({
          ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
          reAuthUrl: shopifyReAuthUrl(storeUrl ?? ""),
        });
        return;
      }
      accessToken = migrated.accessToken;
    }

    let order: any[] = [];
    // let hasNextPage = true;
    // let cursor: string | null = null;
    // let count = 0;

    // while (hasNextPage) {

    const query = `
  query GetOrdersWithFulfillment {
    orders(first: 10) {
      edges {
        cursor
        node {
          id
          name
          createdAt
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
            firstName
            lastName
            email
            phone
          }
          riskLevel
          refunds(){
            id
            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
          lineItems(first: 5) {
            edges {
              node {
                id
                name
                quantity
              }
            }
          }

          fulfillmentOrders(first: 5) {
            nodes {
              id
              status
              requestStatus
              createdAt
              updatedAt
              fulfillAt
              fulfillBy
              fulfillmentHolds {
                reason
                reasonNotes
              }
              deliveryMethod {
                methodType
                minDeliveryDateTime
                maxDeliveryDateTime
              }
              destination {
                city
                countryCode
                zip
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
    `;

    const response = await axios.post(
      `${storeUrl}/admin/api/2025-07/graphql.json`,
      { query },
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    const orderData = response.data.data.orders;
    const edges = orderData.edges;

    for (const edge of edges) {
      const node = edge.node;

      let totalRefunded = 0;
      if (node.refunds && node.refunds.length > 0) {
        totalRefunded = node.refunds.reduce((sum: number, refund: any) => {
          return sum + Number(refund.totalRefundedSet.shopMoney.amount);
        }, 0);
      }

      const existing = await database
        .select()
        .from(orders)
        .where(eq(orders.id, node.id));

      if (existing.length > 0) {
        await database
          .update(orders)
          .set({
            name: node.displayName,
            totalAmount: node.totalPriceSet.shopMoney.amount,
            currency: node.totalPriceSet.shopMoney.currencyCode,
            customerId: node.customer.id,
            customerEmail: node.customer.email,
            customerPhone: node.customer.phone,
            riskLevel: node.riskLevel,
            totalRefunded: totalRefunded.toString(),
            updatedAt: new Date(),
          })
          .where(eq(orders.id, node.id));
      } else {
        await database.insert(orders).values({
          id: node.id,
          name: node.customer.firstName + " " + node.customer.lastName,
          totalAmount: node.totalPriceSet.shopMoney.amount,
          currency: node.totalPriceSet.shopMoney.currencyCode,
          customerId: node.customer.id,
          customerEmail: node.customer.email,
          customerPhone: node.customer.phone,
          riskLevel: node.riskLevel,
          totalRefunded: totalRefunded.toString(),
          createdAt: node.createdAt ? new Date(node.createdAt) : new Date(),
          updatedAt: new Date(),
        });
      }

      for (const lineItem of node.lineItems.edges) {
        const lineItemNode = lineItem.node;

        const existingLineItem = await database
          .select()
          .from(orderItems)
          .where(eq(orderItems.id, lineItemNode.id));

        if (existingLineItem.length > 0) {
          await database
            .update(orderItems)
            .set({
              name: lineItemNode.name,
              quantity: lineItemNode.quantity,
            })
            .where(eq(orderItems.id, lineItemNode.id));
        } else {
          await database.insert(orderItems).values({
            id: lineItemNode.id,
            orderId: node.id,
            name: lineItemNode.name,
            quantity: lineItemNode.quantity,
          });
        }
      }

      for (const fo of node.fulfillmentOrders.nodes) {
        const existingFO = await database
          .select()
          .from(fulfillmentOrders)
          .where(eq(fulfillmentOrders.id, fo.id));

        if (existingFO.length > 0) {
          await database
            .update(fulfillmentOrders)
            .set({
              orderId: node.id,
              status: fo.status,
              requestStatus: fo.requestStatus,
              fulfillAt: fo.fulfillAt ? new Date(fo.fulfillAt as string) : null,
              fulfillBy: fo.fulfillBy ? new Date(fo.fulfillBy as string) : null,
              deliveryMethod: fo.deliveryMethod?.methodType,
              deliveryMinDate: fo.deliveryMethod?.minDeliveryDateTime,
              deliveryMaxDate: fo.deliveryMethod?.maxDeliveryDateTime,
              destCity: fo.destination?.city,
              destCountry: fo.destination?.countryCode,
              destZip: fo.destination?.zip,
              onHoldReason: fo.fulfillmentHolds?.[0]?.reason || null,
            })
            .where(eq(fulfillmentOrders.id, fo.id));
        } else {
          await database.insert(fulfillmentOrders).values({
            id: fo.id,
            orderId: node.id,
            status: fo.status,
            requestStatus: fo.requestStatus,
            fulfillAt: fo.fulfillAt ? new Date(fo.fulfillAt as string) : null,
            fulfillBy: fo.fulfillBy ? new Date(fo.fulfillBy as string) : null,
            deliveryMethod: fo.deliveryMethod?.methodType,
            deliveryMinDate: fo.deliveryMethod?.minDeliveryDateTime
              ? new Date(fo.deliveryMethod.minDeliveryDateTime as string)
              : null,
            deliveryMaxDate: fo.deliveryMethod?.maxDeliveryDateTime
              ? new Date(fo.deliveryMethod.maxDeliveryDateTime as string)
              : null,
            destCity: fo.destination?.city,
            destCountry: fo.destination?.countryCode,
            destZip: fo.destination?.zip,
            onHoldReason: fo.fulfillmentHolds?.[0]?.reason || null,
          });
        }
      }

      order.push(node);
    }

    const simplifiedOrders = edges.map((edge: any) => {
      const node = edge.node;

      return {
        id: node.id,
        name: node.name,
        createdAt: node.createdAt,
        totalAmount: node.totalPriceSet.shopMoney.amount,
        currency: node.totalPriceSet.shopMoney.currencyCode,
        customerId: node.customer?.id,
        customerEmail: node.customer?.email,
        customerPhone: node.customer?.phone,
        riskLevel: node.riskLevel,
        totalRefunded: node.totalRefunded,
        fulfillmentOrders: node.fulfillmentOrders.nodes.map((fo: any) => ({
          id: fo.id,
          status: fo.status,
          requestStatus: fo.requestStatus,
          createdAt: fo.createdAt,
          updatedAt: fo.updatedAt,
          fulfillAt: fo.fulfillAt,
          fulfillBy: fo.fulfillBy,
          deliveryMethod: fo.deliveryMethod?.methodType || null,
          deliveryMinDate: fo.deliveryMethod?.minDeliveryDateTime || null,
          deliveryMaxDate: fo.deliveryMethod?.maxDeliveryDateTime || null,
          destination: {
            city: fo.destination?.city || null,
            countryCode: fo.destination?.countryCode || null,
            zip: fo.destination?.zip || null,
          },
          holds: fo.fulfillmentHolds.map((h: any) => ({
            reason: h.reason,
            notes: h.reasonNotes,
          })),
        })),

        // Items still included
        items: node.lineItems.edges.map((li: any) => ({
          orderItemId: li.node.id,
          orderItemName: li.node.name,
          orderItemQuantity: li.node.quantity,
        })),
      };
    });

    res.status(status.OK).json(simplifiedOrders);
  } catch (error: any) {
    console.error("Error fetching orders:", error.response?.data || error);
    res.status(status.INTERNAL_SERVER_ERROR).json({
      error: "Failed to fetch orders",
    });
  }
};
