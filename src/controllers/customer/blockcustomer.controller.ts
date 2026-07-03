import { status } from "http-status";
import { Request, Response } from "express";
import { logger } from "@/utils/logger.util";
import { database } from "@/configs/connection.config";
import { customers } from "@/schema/schema";
import { eq } from "drizzle-orm";
import axios from "axios";
import { logActivity } from "@/service/logactivity.service";
import { decrypt } from "@/service/encryption.service";
import {
  isShopifyTokenExpired,
  attemptTokenMigration,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

export const blockCustomer = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { customerId } = req.query;
    const storeUrl = req.user?.shopify_url;
    const getStoreToken = req.user?.shopify_access_token;
    let storeToken = getStoreToken ? decrypt(getStoreToken) : null;

    if (isShopifyTokenExpired(req.user?.shopify_token_expires_at)) {
      const migrated = await attemptTokenMigration({
        shopDomain: storeUrl ?? "",
        encryptedToken: getStoreToken ?? "",
        userId: req.user?.id ?? "",
      });
      if (!migrated) {
        res.status(status.UNAUTHORIZED).json({
          ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
          reAuthUrl: shopifyReAuthUrl(storeUrl ?? ""),
        });
        return;
      }
      storeToken = migrated.accessToken;
    }

    if (!customerId) {
      res
        .status(status.BAD_REQUEST)
        .json({ message: "Customer ID is required" });
    }

    const customer = await database
      .select()
      .from(customers)
      .where(eq(customers.id, customerId as string));

    if (!customer) {
      res.status(status.NOT_FOUND).json({ message: "Customer not found" });
    }

    const mutation = `
    mutation customerUpdate($id: ID!, $tags: [String!]) {
        customerUpdate(input: {id: $id, tags: $tags}) {
            customer{
                id
                tags
            }
            userErrors {
                field
                message
            }
        }
    }`;

    const response = await axios.post(
      `${storeUrl}/admin/api/2025-07/graphql.json`,
      {
        query: mutation,
        variables: { id: customerId as string, tags: ["BLOCKED"] },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": storeToken,
        },
      }
    );

    if (response.data.data.customerUpdate.userErrors.length <= 0) {
      await database
        .update(customers)
        .set({ blocked: true, tags: "BLOCKED" })
        .where(eq(customers.id, customerId as string));
    }

    await logActivity({
      storeId: req.user?.id ?? "unknown",
      action: "BLOCK_CUSTOMER",
      for: "store",
      customerId: customerId as string,
      meta: { storeUrl },
    });

    res.status(status.OK).json({ message: "Customer blocked successfully" });
  } catch (error: any) {
    res.status(status.INTERNAL_SERVER_ERROR).json({ message: error.message });
    logger.error(error.message);
  }
};

export const unblockCustomer = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { customerId } = req.query;
    const storeUrl = req.user?.shopify_url;
    const getStoreToken = req.user?.shopify_access_token;
    let storeToken = getStoreToken ? decrypt(getStoreToken) : null;

    if (isShopifyTokenExpired(req.user?.shopify_token_expires_at)) {
      const migrated = await attemptTokenMigration({
        shopDomain: storeUrl ?? "",
        encryptedToken: getStoreToken ?? "",
        userId: req.user?.id ?? "",
      });
      if (!migrated) {
        res.status(status.UNAUTHORIZED).json({
          ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
          reAuthUrl: shopifyReAuthUrl(storeUrl ?? ""),
        });
        return;
      }
      storeToken = migrated.accessToken;
    }

    if (!customerId) {
      res
        .status(status.BAD_REQUEST)
        .json({ message: "Customer ID is required" });
      return;
    }

    const customer = await database
      .select()
      .from(customers)
      .where(eq(customers.id, customerId as string))
      .limit(1);

    if (!customer.length) {
      res.status(status.NOT_FOUND).json({ message: "Customer not found" });
      return;
    }

    const fetchQuery = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
          tags
        }
      }
    `;

    const fetchResponse = await axios.post(
      `${storeUrl}/admin/api/2025-07/graphql.json`,
      {
        query: fetchQuery,
        variables: { id: customerId },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": storeToken,
        },
      }
    );

    let currentTags: string[] = fetchResponse.data.data.customer.tags || [];

    const updatedTags = currentTags.filter((tag: string) => tag !== "BLOCKED");

    const mutation = `
      mutation customerUpdate($id: ID!, $tags: [String!]) {
        customerUpdate(input: {id: $id, tags: $tags}) {
          customer {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }`;

    const response = await axios.post(
      `${storeUrl}/admin/api/2025-07/graphql.json`,
      {
        query: mutation,
        variables: { id: customerId, tags: updatedTags },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": storeToken,
        },
      }
    );

    if (response.data.data.customerUpdate.userErrors.length === 0) {
      await database
        .update(customers)
        .set({ blocked: false, tags: updatedTags.join(",") })
        .where(eq(customers.id, customerId as string));
    }

    await logActivity({
      storeId: req.user?.id ?? "unknown",
      action: "UNBLOCK_CUSTOMER",
      for: "store",
      customerId: customerId as string,
      meta: { storeUrl },
    });

    res.status(status.OK).json({ message: "Customer unblocked successfully" });
  } catch (error: any) {
    res.status(status.INTERNAL_SERVER_ERROR).json({ message: error.message });
    logger.error(error.message);
  }
};
