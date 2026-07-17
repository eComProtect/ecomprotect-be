import { database } from "@/configs/connection.config";
import { customers, orders, settings, users } from "@/schema/schema";
import { eq, sql, and } from "drizzle-orm";
import axios from "axios";
import { ADMIN_API_VERSION } from "@/configs/shopify.config";
import {
  buildReturnsSelection,
  countLossEvents,
  getRiskRelevantReturns,
  hasLossEvents,
  hasReturnAccessError,
} from "@/service/shopify-loss-events.service";

interface ExclusionItem {
  id: string;
  type: "customer" | "address";
  value: string;
}

/** Check if customer email is in the exclusion list (email only, no order/address logic). */
function isEmailExcluded(
  exclusionList: string | null | undefined,
  customerEmail: string | null | undefined
): boolean {
  if (!exclusionList || !customerEmail) return false;
  try {
    const exclusions: ExclusionItem[] = Array.isArray(exclusionList)
      ? exclusionList
      : JSON.parse(exclusionList || "[]");
    if (!Array.isArray(exclusions) || exclusions.length === 0) return false;
    const emailLower = customerEmail.toLowerCase().trim();
    return exclusions.some(
      (item) =>
        item.type === "customer" &&
        item.value.toLowerCase().trim() === emailLower
    );
  } catch (error) {
    console.error("Error parsing exclusion list:", error);
    return false;
  }
}

const buildOrderSelection = (includeReturns: boolean) => `
  id
  name
  createdAt
  totalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }
  riskLevel
  refunds(first: 5) {
    id
    totalRefundedSet {
      shopMoney {
        amount
        currencyCode
      }
    }
  }
  ${buildReturnsSelection({ includeReturns, limit: 5 })}
  fulfillmentOrders(first: 5) {
    nodes {
      id
      status
      requestStatus
      fulfillBy
    }
  }
`;

const buildCustomerByIdQuery = (includeReturns: boolean) => `
  query($customerId: ID!) {
    customer(id: $customerId) {
      id
      firstName
      lastName
      email
      phone
      orders(first: 100) {
        edges {
          node {
            ${buildOrderSelection(includeReturns)}
          }
        }
      }
    }
  }
`;

const buildCustomerByEmailQuery = (includeReturns: boolean) => `
  query($emailQuery: String!) {
    customers(first: 1, query: $emailQuery) {
      edges {
        node {
          id
          firstName
          lastName
          email
          phone
          orders(first: 100) {
            edges {
              node {
                ${buildOrderSelection(includeReturns)}
              }
            }
          }
        }
      }
    }
  }
`;

const postShopifyQuery = async ({
  storeUrl,
  accessToken,
  query,
  variables,
}: {
  storeUrl?: string;
  accessToken?: string;
  query: string;
  variables: Record<string, unknown>;
}) => {
  try {
    return await axios.post(
      `${storeUrl}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
      { query, variables },
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (axiosError: any) {
    console.error(
      "Axios error fetching from Shopify:",
      axiosError.response?.data || axiosError.message
    );
    throw axiosError;
  }
};

export const calculateRiskyOrders = async ({
  storeId,
  customerId,
  storeUrl,
  accessToken,
}: {
  storeId: string;
  customerId: string;
  storeUrl?: string;
  accessToken?: string;
}) => {
  // ---- Load settings ----
  // No row for a store yet (never configured Additional Configuration) falls
  // back to defaults instead of failing risk checks outright: no rate
  // threshold configured (skips rate-based flagging, matching how a null
  // lossRateThreshold on an existing row already behaves) and no exclusions.
  const DEFAULT_SETTINGS = {
    lossRateThreshold: null as number | null,
    exclusionList: null as string | null,
  };

  const [setting] = await database
    .select()
    .from(settings)
    .where(eq(settings.storeId, storeId));

  const { lossRateThreshold, exclusionList } = {
    ...DEFAULT_SETTINGS,
    ...(setting ?? {}),
  };

  // ---- Load customer ----
  const [customerRecord] = await database
    .select()
    .from(customers)
    .where(eq(customers.id, customerId));

  if (!customerRecord) throw new Error("Customer not found");

  const { totalOrders, totalRefunded, riskySince, email, phone, riskLevel } =
    customerRecord;

  // If customer email is in exclusion list, do not treat as risky (orders still appear, none flagged)
  const customerExcluded = isEmailExcluded(exclusionList, email);

  const crossStoreQuery = await database
    .select({ storeId: customers.id })
    .from(customers)
    .innerJoin(users, eq(customers.id, users.id))
    .where(
      and(
        totalRefunded ? sql`${customers.totalRefunded} > 0` : sql`false`,
        email
          ? eq(customers.email, email)
          : phone
          ? eq(customers.phone, phone)
          : sql`false`
      )
    );

  const refundsFromStores = new Set(
    crossStoreQuery.map((row: any) => row.storeId)
  ).size;

  let includeReturns = true;
  let response = await postShopifyQuery({
    storeUrl,
    accessToken,
    query: buildCustomerByIdQuery(includeReturns),
    variables: { customerId },
  });

  if (hasReturnAccessError(response.data?.errors)) {
    includeReturns = false;
    console.warn(
      `Shopify return data unavailable for ${storeUrl}; risk checks will fall back to refunds only.`
    );
    response = await postShopifyQuery({
      storeUrl,
      accessToken,
      query: buildCustomerByIdQuery(false),
      variables: { customerId },
    });
  }

  if (response.data?.errors) {
    console.error(
      "Shopify GraphQL Errors:",
      JSON.stringify(response.data.errors, null, 2)
    );
  }

  let customerData = response.data.data?.customer;

  if (!customerData && email) {
    console.log(
      `Customer not found by ID (${customerId}). Attempting fallback search by email: ${email}`
    );

    let searchResponse = await postShopifyQuery({
      storeUrl,
      accessToken,
      query: buildCustomerByEmailQuery(includeReturns),
      variables: { emailQuery: `email:${email}` },
    });

    if (includeReturns && hasReturnAccessError(searchResponse.data?.errors)) {
      includeReturns = false;
      console.warn(
        `Shopify return data unavailable for ${storeUrl}; email fallback will use refunds only.`
      );
      searchResponse = await postShopifyQuery({
        storeUrl,
        accessToken,
        query: buildCustomerByEmailQuery(false),
        variables: { emailQuery: `email:${email}` },
      });
    }

    if (searchResponse.data?.errors) {
      console.error(
        "Shopify GraphQL Errors during email fallback:",
        JSON.stringify(searchResponse.data.errors, null, 2)
      );
    }

    const firstMatch = searchResponse.data.data?.customers?.edges?.[0]?.node;
    if (firstMatch) {
      console.log(`Found customer match via email search. New ID: ${firstMatch.id}`);
      customerData = firstMatch;
    }
  }

  if (!customerData) {
    console.error(
      "Shopify Response Data (Final Failure):",
      JSON.stringify(response.data, null, 2)
    );
    throw new Error(
      `Failed to fetch customer orders from Shopify. Customer ID: ${customerId}, Email: ${email}`
    );
  }

  const shopifyOrders = customerData.orders.edges.map((edge: any) => edge.node);
  const totalOrdersForRisk =
    shopifyOrders.length > 0 ? shopifyOrders.length : Number(totalOrders || 0);
  const ordersWithLossEvents = shopifyOrders.filter((ord: any) =>
    hasLossEvents(ord)
  ).length;
  const totalLossEvents = shopifyOrders.reduce(
    (sum: number, ord: any) => sum + countLossEvents(ord),
    0
  );
  const refundRate =
    totalOrdersForRisk > 0 ? (ordersWithLossEvents / totalOrdersForRisk) * 100 : 0;
  const rateLabel = includeReturns ? "Refund/return" : "Refund";

  const customerRiskReasons: string[] = [];
  let isNowRisky = false;

  if (!customerExcluded && refundRate > (lossRateThreshold ?? 0)) {
    isNowRisky = true;
    customerRiskReasons.push(
      `${rateLabel} rate ${refundRate.toFixed(
        2
      )}% exceeds threshold ${lossRateThreshold}%`
    );
  }

  let effectiveRiskySince = riskySince;

  if (isNowRisky && !riskySince) {
    const now = new Date();
    effectiveRiskySince = now;
    await database
      .update(customers)
      .set({ riskySince: effectiveRiskySince })
      .where(eq(customers.id, customerId));
  }

  const orderResults: any[] = [];

  for (const ord of shopifyOrders) {
    let flagged = false;
    const reasons: string[] = [];

    let riskySinceDate: number | null = null;

    if (effectiveRiskySince) {
      riskySinceDate = new Date(effectiveRiskySince).getTime();
    }

    const orderCreatedDate = new Date(ord.createdAt).getTime();
    const orderCreatedDateVal = new Date(ord.createdAt);
    const isRiskyCustomer = !customerExcluded && (isNowRisky || !!effectiveRiskySince);

    if (
      isRiskyCustomer &&
      riskySinceDate !== null &&
      orderCreatedDate >= riskySinceDate
    ) {
      flagged = true;
      reasons.push("Customer became risky before this order");
      // Add the specific reasons why the customer was flagged
      if (customerRiskReasons.length > 0) {
        reasons.push(...customerRiskReasons);
      }
    }

    let refundsTotal = 0;
    if (ord.refunds && Array.isArray(ord.refunds) && ord.refunds.length > 0) {
      refundsTotal = ord.refunds.reduce((sum: number, r: any) => {
        const amt = Number(r.totalRefundedSet?.shopMoney?.amount || 0);
        return sum + (isNaN(amt) ? 0 : amt);
      }, 0);
    }

    const totalAmount = Number(ord.totalPriceSet.shopMoney.amount);
    const relevantReturns = getRiskRelevantReturns(ord);

    if (refundsTotal >= totalAmount) {
      flagged = true;
      reasons.push("Order fully refunded");
    }

    if (relevantReturns.length > 0) {
      flagged = true;

      if (relevantReturns.length === 1) {
        const returnStatus = relevantReturns[0].status
          ? relevantReturns[0].status.toLowerCase().replace(/_/g, " ")
          : null;
        reasons.push(
          returnStatus
            ? `Order has a ${returnStatus} return`
            : "Order has a return"
        );
      } else {
        reasons.push(`Order has ${relevantReturns.length} return records`);
      }
    }

    if (ord.fulfillmentOrders && ord.fulfillmentOrders.nodes) {
      for (const fo of ord.fulfillmentOrders.nodes) {
        if (fo.status !== "FULFILLED" && fo.fulfillBy) {
          const fulfillByDate = new Date(fo.fulfillBy);
          if (fulfillByDate < new Date()) {
            flagged = true;
            reasons.push("Fulfillment overdue");
            break;
          }
        }
      }
    }

    // Save order in DB if new
    const existing = await database
      .select()
      .from(orders)
      .where(eq(orders.id, ord.id));

    if (existing.length > 0 && existing[0].manualFlag) {
      if (existing[0].manualFlag === true) {
        flagged = true;
        reasons.push("Manually flagged");
      } else if (existing[0].manualFlag === false) {
        flagged = false;
        reasons.push("Manually unflagged");
      }
    }

    if (existing.length === 0) {
      await database.insert(orders).values({
        id: ord.id,
        name: ord.name,
        totalAmount: ord.totalPriceSet.shopMoney.amount,
        currency: ord.totalPriceSet.shopMoney.currencyCode,
        customerId,
        customerEmail: customerData.email,
        customerPhone: customerData.phone,
        riskLevel: ord.riskLevel,
        flagged: customerExcluded ? false : flagged,
        manualFlag: null,
        createdAt: orderCreatedDateVal,
        updatedAt: new Date(),
        totalRefunded: refundsTotal.toString(),
      });
    }

    orderResults.push({
      ...ord,
      totalAmount,
      flagged: customerExcluded ? false : flagged,
      manualFlag: null,
      reasons,
      refundsTotal,
      returnsTotal: relevantReturns.length,
    });
  }

  return {
    customer: {
      id: customerRecord.id,
      email: customerRecord.email,
      totalOrders: totalOrdersForRisk,
      totalRefunded: String(totalLossEvents || totalRefunded || 0),
      refundRate: refundRate.toFixed(2) + "%",
      isRisky: isNowRisky,
      riskySince: effectiveRiskySince,
      reasons: customerRiskReasons,
      manualFlag: null,
      refundsFromStores,
      riskLevel,
    },
    orders: orderResults,
  };
};
