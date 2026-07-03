import status from "http-status";
import { Request, Response } from "express";
import axios from "axios";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "@/service/encryption.service";
import {
  isShopifyTokenExpired,
  attemptTokenMigration,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

/**
 * Fetch refund history of a specific customer from Shopify
 */
export const getCustomerRefundHistoryFromShopify = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userId } = req.params;
    const { customerId } = req.query;

    console.log("REQUEST PARAMS:-", req.params);

    if (!userId) {
      res.status(status.BAD_REQUEST).json({ error: "User ID is required" });
      return;
    }

    const [userData] = await database
      .select()
      .from(users)
      .where(eq(users.id, userId));

    if (!userData) {
      res.status(status.NOT_FOUND).json({ error: "User not found" });
      return;
    }

    const storeUrl = userData?.shopify_url;
    const getAccessToken = userData?.shopify_access_token;
    let accessToken = getAccessToken ? decrypt(getAccessToken) : null;

    if (isShopifyTokenExpired(userData?.shopify_token_expires_at)) {
      const migrated = await attemptTokenMigration({
        shopDomain: storeUrl ?? "",
        encryptedToken: getAccessToken ?? "",
        userId: userData.id,
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

    console.log("customerId", customerId);
    console.log("Query ID:---->", req.query);

    if (!storeUrl || !accessToken) {
      res
        .status(status.UNAUTHORIZED)
        .json({ error: "Missing Shopify credentials" });
      return;
    }

    if (!customerId) {
      res.status(status.BAD_REQUEST).json({ error: "Customer ID is required" });
      return;
    }

    // GraphQL query to fetch refunds for a customer
    const query = `
      {
        customer(id: "${customerId}") {
          id
          displayName
          email
          orders(first: 50, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                refunds(first: 10) {
                  id
                  createdAt
                  note
                  refundLineItems(first: 10) {
                    edges {
                      node {
                        quantity
                        lineItem {
                          name
                          originalUnitPriceSet {
                            shopMoney {
                              amount
                              currencyCode
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
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

    const customer = response.data.data.customer;
    if (!customer) {
      res.status(status.NOT_FOUND).json({ error: "Customer not found" });
      return;
    }

    // Format refunds
    const refundHistory = [];
    for (const edge of customer.orders.edges) {
      const order = edge.node;
      if (order.refunds.length > 0) {
        for (const refund of order.refunds) {
          refundHistory.push({
            orderId: order.id,
            orderName: order.name,
            orderDate: order.createdAt,
            refundId: refund.id,
            refundDate: refund.createdAt,
            note: refund.note,
            items: refund.refundLineItems.edges.map((r: any) => ({
              product: r.node.lineItem.name,
              quantity: r.node.quantity,
              price: r.node.lineItem.originalUnitPriceSet.shopMoney.amount,
              currency:
                r.node.lineItem.originalUnitPriceSet.shopMoney.currencyCode,
            })),
          });
        }
      }
    }

    res.status(status.OK).json({
      customer: {
        id: customer.id,
        name: customer.displayName,
        email: customer.email,
      },
      totalRefunds: refundHistory.length,
      refunds: refundHistory,
    });
  } catch (error: any) {
    console.error(
      "Error fetching customer refunds from Shopify:",
      error.response?.data || error.message
    );
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to fetch refund history from Shopify" });
  }
};
