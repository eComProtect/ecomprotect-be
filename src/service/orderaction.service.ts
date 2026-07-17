import axios from "axios";
import { ADMIN_API_VERSION } from "@/configs/shopify.config";

interface OrderActionParams {
  storeUrl: string;
  accessToken: string;
  gOrderId: string; // Shopify GID, e.g. "gid://shopify/Order/123"
}

interface GraphQLTopLevelError {
  message?: string;
  extensions?: { code?: string };
}

/**
 * Throws with the full response body attached whenever a Shopify GraphQL
 * call fails at the top level (bad/sunset API version, invalid query shape,
 * throttling, auth) — as opposed to a business-logic userErrors rejection,
 * which callers handle themselves. Previously nothing checked for this at
 * all: every call site read straight through `data?.data?.…`, so a top-level
 * `errors` array (with `data` absent or null) silently produced an empty
 * array via `?? []` and the code proceeded as if zero fulfillment orders
 * existed / the mutation had nothing to report — never actually reaching
 * Shopify, but logging as if it had.
 */
const assertNoTopLevelErrors = (res: { data?: { errors?: GraphQLTopLevelError[] } }, context: string) => {
  if (res.data?.errors && res.data.errors.length > 0) {
    throw new Error(
      `Shopify GraphQL request failed (${context}): ${JSON.stringify(res.data.errors)}`
    );
  }
};

/**
 * Places a hold on every open fulfillment order for this order, and leaves a
 * note on the order for merchant visibility in Shopify Admin.
 *
 * Shared between the immediate-fire path (order.webhook.ts, when no delay is
 * configured) and the deferred-execution path (pendingriskactions.job.ts,
 * when actionDelayHours > 0) so both call identical logic.
 */
export const holdOrderFulfillment = async (
  params: OrderActionParams & { reasons: string[] }
): Promise<void> => {
  const { storeUrl, accessToken, gOrderId, reasons } = params;
  const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };
  const endpoint = `${storeUrl}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

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
  const queryFulfillmentOrders = () =>
    axios.post(endpoint, { query: foGqlQuery, variables: { orderId: gOrderId } }, { headers });

  let foRes = await queryFulfillmentOrders();
  assertNoTopLevelErrors(foRes, "getFulfillmentOrders");

  let foNodes: Array<{ id: string; status: string }> =
    foRes.data?.data?.order?.fulfillmentOrders?.nodes ?? [];
  let openFOs = foNodes.filter((fo) => fo.status === "OPEN");

  if (openFOs.length === 0) {
    // Shopify creates fulfillment orders as part of order creation, but
    // there's no documented guarantee they exist at the exact instant the
    // orders/create webhook fires — retry once after a short delay to rule
    // out that race before treating this as "genuinely nothing to hold".
    await new Promise((resolve) => setTimeout(resolve, 5000));
    foRes = await queryFulfillmentOrders();
    assertNoTopLevelErrors(foRes, "getFulfillmentOrders (retry)");
    foNodes = foRes.data?.data?.order?.fulfillmentOrders?.nodes ?? [];
    openFOs = foNodes.filter((fo) => fo.status === "OPEN");
  }

  if (openFOs.length === 0) {
    // Log the raw statuses Shopify actually returned so this is diagnosable
    // from the logs alone next time, instead of a generic "nothing found".
    console.warn(
      `⚠️ No open fulfillment orders for ${gOrderId} after retry — nothing to hold. ` +
        `Shopify returned: ${JSON.stringify(foNodes)}`
    );
  }

  const holdMutation = `
    mutation fulfillmentOrderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
      fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
        fulfillmentHold { id }
        userErrors { message }
      }
    }
  `;
  for (const fo of openFOs) {
    const holdRes = await axios.post(
      endpoint,
      {
        query: holdMutation,
        variables: {
          id: fo.id,
          fulfillmentHold: {
            reason: "OTHER",
            reasonNotes: `Fulfillment held by eComProtect. Identified risk factors: ${reasons.join("; ")}. Please perform a manual review before fulfilling.`,
            notifyMerchant: false,
          },
        },
      },
      { headers }
    );
    assertNoTopLevelErrors(holdRes, `fulfillmentOrderHold ${fo.id}`);

    const holdPayload = holdRes.data?.data?.fulfillmentOrderHold;
    const holdErrors = holdPayload?.userErrors ?? [];
    if (holdErrors.length > 0) {
      throw new Error(`Hold rejected for FO ${fo.id}: ${JSON.stringify(holdErrors)}`);
    }
    if (!holdPayload?.fulfillmentHold?.id) {
      // Zero userErrors but no hold object back either — Shopify accepted
      // the request shape but didn't actually create a hold. Treat as a
      // failure rather than logging success on data that isn't there.
      throw new Error(
        `Hold for FO ${fo.id} returned no fulfillmentHold and no userErrors — response: ${JSON.stringify(holdRes.data)}`
      );
    }
    console.log(`✅ Hold confirmed on FO ${fo.id} (hold id: ${holdPayload.fulfillmentHold.id})`);
  }

  const orderUpdateMutation = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { message }
      }
    }
  `;
  const noteRes = await axios.post(
    endpoint,
    {
      query: orderUpdateMutation,
      variables: {
        input: {
          id: gOrderId,
          note: `eComProtect: Fulfillment on hold. Risk factors: ${reasons.join("; ")}`,
        },
      },
    },
    { headers }
  );
  assertNoTopLevelErrors(noteRes, "orderUpdate (note)");
  const noteErrors = noteRes.data?.data?.orderUpdate?.userErrors ?? [];
  if (noteErrors.length > 0) {
    // Non-fatal — the hold itself already succeeded above; the order note
    // is a visibility nicety, not the thing the merchant/policy relies on.
    console.error(`Order note update rejected for ${gOrderId}:`, noteErrors);
  }
};

/** Cancels the order via Shopify's orderCancel mutation. */
export const cancelShopifyOrder = async (params: OrderActionParams): Promise<void> => {
  const { storeUrl, accessToken, gOrderId } = params;
  const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };
  const endpoint = `${storeUrl}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

  const cancelMutation = `
    mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean!) {
      orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer) {
        job { id }
        orderCancelUserErrors { message }
      }
    }
  `;
  const cancelRes = await axios.post(
    endpoint,
    { query: cancelMutation, variables: { orderId: gOrderId, reason: "FRAUD", notifyCustomer: true } },
    { headers }
  );
  assertNoTopLevelErrors(cancelRes, "orderCancel");

  const cancelPayload = cancelRes.data?.data?.orderCancel;
  const cancelErrors = cancelPayload?.orderCancelUserErrors ?? [];
  if (cancelErrors.length > 0) {
    throw new Error(`Cancel rejected for ${gOrderId}: ${JSON.stringify(cancelErrors)}`);
  }
  if (!cancelPayload?.job?.id) {
    throw new Error(
      `Cancel for ${gOrderId} returned no job and no userErrors — response: ${JSON.stringify(cancelRes.data)}`
    );
  }
  console.log(`✅ Order cancellation queued for ${gOrderId} (job id: ${cancelPayload.job.id}).`);
};
