import { status } from "http-status";
import { Request, Response } from "express";
import { logger } from "@/utils/logger.util";
import { database } from "@/configs/connection.config";
import { customers } from "@/schema/schema";
import { eq } from "drizzle-orm";
import axios from "axios";
import { logActivity } from "@/service/logactivity.service";
import { ADMIN_API_VERSION } from "@/configs/shopify.config";
import {
  resolveStoreShopifyAccess,
  shopifyReAuthUrl,
  SHOPIFY_TOKEN_EXPIRED_RESPONSE,
} from "@/utils/shopify-token.util";

export const blockCustomer = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { customerId } = req.query;

    if (!req.user) {
      res.status(status.UNAUTHORIZED).json({ message: "Not authenticated" });
      return;
    }

    const resolved = await resolveStoreShopifyAccess(req.user);
    if (!resolved) {
      res.status(status.UNAUTHORIZED).json({
        ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
        reAuthUrl: shopifyReAuthUrl(req.user.shopify_url ?? ""),
      });
      return;
    }
    const { store, accessToken: storeToken } = resolved;
    const storeUrl = store.shopify_url;

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
      `${storeUrl}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
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
      storeId: store.id,
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

    if (!req.user) {
      res.status(status.UNAUTHORIZED).json({ message: "Not authenticated" });
      return;
    }

    const resolved = await resolveStoreShopifyAccess(req.user);
    if (!resolved) {
      res.status(status.UNAUTHORIZED).json({
        ...SHOPIFY_TOKEN_EXPIRED_RESPONSE,
        reAuthUrl: shopifyReAuthUrl(req.user.shopify_url ?? ""),
      });
      return;
    }
    const { store, accessToken: storeToken } = resolved;
    const storeUrl = store.shopify_url;

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
      `${storeUrl}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
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
      `${storeUrl}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
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
      storeId: store.id,
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
