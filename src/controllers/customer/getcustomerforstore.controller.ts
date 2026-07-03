import status from "http-status";
import { Request, Response } from "express";
import { customers, settings } from "@/schema/schema";
import { eq, and } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import axios from "axios";
import { logger } from "@/utils/logger.util";
import { calculateCustomerRisk } from "@/service/riskycustomer.service";
import { logActivity } from "@/service/logactivity.service";
import { decrypt } from "@/service/encryption.service";
import {
  buildReturnsSelection,
  countLossEvents,
  hasReturnAccessError,
} from "@/service/shopify-loss-events.service";
import {
  isShopifyTokenExpired,
  attemptTokenMigration,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

/** Check if customer email is in the store's exclusion list (Additional Configuration). */
function isEmailExcluded(
  exclusionList: string | null | undefined,
  customerEmail: string | null | undefined
): boolean {
  if (!exclusionList || !customerEmail) return false;
  try {
    const exclusions = Array.isArray(exclusionList)
      ? exclusionList
      : JSON.parse(exclusionList || "[]");
    if (!Array.isArray(exclusions) || exclusions.length === 0) return false;
    const emailLower = customerEmail.toLowerCase().trim();
    return exclusions.some(
      (item: any) =>
        item.type === "customer" &&
        (item.value || "").toLowerCase().trim() === emailLower
    );
  } catch (error) {
    return false;
  }
}

/**
 * This is to fetch all the customers from the Shopfiy of logged in user.
 */
export const getCustomerRefundsAcrossStores = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const data = req.user;
    const storeUrl = data?.shopify_url;

    const getAccessToken = data?.shopify_access_token;
    const storeId = data?.id;

    if (!storeUrl || !getAccessToken || !storeId) {
      res
        .status(status.UNAUTHORIZED)
        .json({ error: "Missing Shopify credentials or Store ID" });
      return;
    }

    let accessToken = decrypt(getAccessToken!);

    if (isShopifyTokenExpired(data?.shopify_token_expires_at)) {
      const migrated = await attemptTokenMigration({
        shopDomain: storeUrl,
        encryptedToken: getAccessToken!,
        userId: storeId!,
      });
      if (!migrated) {
        res.status(status.UNAUTHORIZED).json({
          ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
          reAuthUrl: shopifyReAuthUrl(storeUrl),
        });
        return;
      }
      accessToken = migrated.accessToken;
    }

    const settingsResult = await database
      .select()
      .from(settings)
      .where(eq(settings.storeId, storeId as string));

    if (!settingsResult) {
      res
        .status(status.BAD_REQUEST)
        .json({ error: "Please configure you settings." });
    }

    const riskSettings = settingsResult[0];
    const exclusionList = riskSettings?.exclusionList ?? null;

    const buildCustomerSyncQuery = (includeReturns: boolean) => `
      {
        customers(first: 20) {
          edges {
            node {
              id
              displayName
              firstName
              lastName
              email
              phone
              tags
              defaultAddress {
                address1
                address2
                zip
                city
              }
              orders(first: 50) {
                edges {
                  node {
                    legacyResourceId
                    createdAt
                    refunds(first: 10) {
                      id
                      createdAt
                    }
                    ${buildReturnsSelection({
                      includeReturns,
                      limit: 10,
                      includeCreatedAt: true,
                    })}
                  }
                }
              }
            }
          }
        }
      }
    `;

    const shopifyHeaders = {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    };

    let includeReturns = true;
    let response = await axios.post(
      `${storeUrl}/admin/api/2025-07/graphql.json`,
      { query: buildCustomerSyncQuery(includeReturns) },
      {
        headers: shopifyHeaders,
      }
    );

    if (hasReturnAccessError(response.data?.errors)) {
      includeReturns = false;
      console.warn(
        `Shopify return data unavailable for ${storeUrl}; syncing customers with refunds only.`
      );
      response = await axios.post(
        `${storeUrl}/admin/api/2025-07/graphql.json`,
        { query: buildCustomerSyncQuery(false) },
        {
          headers: shopifyHeaders,
        }
      );
    }

    if (response.data?.errors) {
      console.error(
        "Shopify GraphQL Errors while syncing customers:",
        JSON.stringify(response.data.errors, null, 2)
      );
    }

    const customerEdges = response.data.data?.customers?.edges ?? [];

    const upsertPromises = [];

    for (const edge of customerEdges) {
      const node = edge.node;
      const refundedStores = new Set<string>();

      let lastKnownIp: string | null = null;
      let riskProfile = calculateCustomerRisk(node, riskSettings);

      const totalOrders = node.orders.edges.length;
      const totalLossEvents = node.orders.edges.reduce(
        (acc: number, o: any) => acc + countLossEvents(o.node),
        0
      );
      if (totalLossEvents > 0 && storeId) {
        refundedStores.add(storeId);
      }
      if (node.orders.edges.length > 0) {
        const mostRecentOrder = node.orders.edges[0].node;
        const legacyOrderId = mostRecentOrder.legacyResourceId;
        const gidOrderId = `gid://shopify/Order/${legacyOrderId}`;

        try {
          const ipQuery = `
            query getOrderIP($id: ID!) {
              order(id: $id) {
                browserIp
              }
            }
          `;
          const orderIpResp = await axios.post(
            `${storeUrl}/admin/api/2025-07/graphql.json`,
            { query: ipQuery, variables: { id: gidOrderId } },
            {
              headers: {
                "X-Shopify-Access-Token": accessToken,
                "Content-Type": "application/json",
              },
            }
          );
          lastKnownIp = orderIpResp.data?.data?.order?.browserIp ?? null;
        } catch (apiError: any) {
          console.error(
            `Failed to fetch order ${legacyOrderId} for IP:`,
            apiError.response?.data || apiError.message
          );
        }
      }
      if (lastKnownIp) {
        const flaggedOnSameIp = await database
          .select()
          .from(customers)
          .where(
            and(eq(customers.ip, lastKnownIp), eq(customers.flagged, true))
          );

        if (flaggedOnSameIp.length > 0) {
          riskProfile = {
            isFlagged: true,
            riskLevel: 100,
            riskReason: `Shares IP (${lastKnownIp}) with a flagged customer.`,
          };
        }
      }

      const customerEmail = node.email ?? "N/A";

      // If customer email is in Additional Configuration exclusion list, do not treat as risky
      if (isEmailExcluded(exclusionList, node.email)) {
        riskProfile = {
          isFlagged: false,
          riskLevel: 0,
          riskReason: "In exclusion list",
        };
      }

      let flaggedStoresCount = 0;
      if (customerEmail !== "N/A") {
        const flaggedStores = await database
          .selectDistinct({ storeId: customers.storeId })
          .from(customers)
          .where(
            and(eq(customers.email, customerEmail), eq(customers.flagged, true))
          );

        flaggedStoresCount = flaggedStores.length;
      }

      await logActivity({
        action: "UPSERT_CUSTOMER",
        for: "customer",
        storeId,
        customerId: node.id,
        meta: {
          totalOrders,
          totalLossEvents,
          returnsIncluded: includeReturns,
          ip: lastKnownIp,
          flagged: riskProfile.isFlagged,
        },
      });

      const customerDataToUpsert = {
        id: node.id,
        name: node.displayName ?? "N/A",
        firstName: node.firstName ?? "",
        surname: node.lastName ?? "",
        email: node.email ?? "N/A",
        phone: node.phone ?? "N/A",
        address: node.defaultAddress ? `${node.defaultAddress.address1} ${node.defaultAddress.address2 || ''}, ${node.defaultAddress.city || ''}`.trim() : "",
        postCode: node.defaultAddress?.zip ?? "",
        totalRefunded: String(totalLossEvents),
        ip: lastKnownIp,
        totalOrders: totalOrders,
        flagged: riskProfile.isFlagged,
        riskLevel: Number(riskProfile.riskLevel),
        riskReason: riskProfile.riskReason ?? "",
        refundsFromStores: refundedStores.size,
        flaggedStoresCount,
        storeId: storeId,
        tags: Array.isArray(node.tags) ? node.tags.join(",") : (node.tags || ""),
      };

      const promise = database
        .insert(customers)
        .values(customerDataToUpsert)
        .onConflictDoUpdate({
          target: customers.id,
          set: {
            ...customerDataToUpsert,
          },
        })
        .returning();

      upsertPromises.push(promise);
    }

    const resultFinal = await Promise.all(upsertPromises);

    res.status(status.OK).json({
      message: "Customers synced successfully.",
      data: resultFinal.flat(),
    });
  } catch (error: any) {
    console.error("Full error object in sync customers:", error);

    logger.error(
      "Error syncing customers:",
      error.response?.data || error.message
    );
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ error: "Failed to sync customers" });
  }
};
