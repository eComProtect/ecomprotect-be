import axios from "axios";

interface OrderActionParams {
  storeUrl: string;
  accessToken: string;
  gOrderId: string; // Shopify GID, e.g. "gid://shopify/Order/123"
}

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
  const endpoint = `${storeUrl}/admin/api/2025-07/graphql.json`;

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
  const foRes = await axios.post(endpoint, { query: foGqlQuery, variables: { orderId: gOrderId } }, { headers });

  const foNodes: Array<{ id: string; status: string }> =
    foRes.data?.data?.order?.fulfillmentOrders?.nodes ?? [];
  const openFOs = foNodes.filter((fo) => fo.status === "OPEN");

  const holdMutation = `
    mutation fulfillmentOrderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
      fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
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
    const holdErrors = holdRes.data?.data?.fulfillmentOrderHold?.userErrors ?? [];
    if (holdErrors.length > 0) {
      console.error(`Hold errors for FO ${fo.id}:`, holdErrors);
    } else {
      console.log(`✅ Hold applied to FO ${fo.id}`);
    }
  }

  const orderUpdateMutation = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { message }
      }
    }
  `;
  await axios.post(
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
};

/** Cancels the order via Shopify's orderCancel mutation. */
export const cancelShopifyOrder = async (params: OrderActionParams): Promise<void> => {
  const { storeUrl, accessToken, gOrderId } = params;
  const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };

  const cancelMutation = `
    mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean!) {
      orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer) {
        orderCancelUserErrors { message }
      }
    }
  `;
  const cancelRes = await axios.post(
    `${storeUrl}/admin/api/2025-07/graphql.json`,
    { query: cancelMutation, variables: { orderId: gOrderId, reason: "FRAUD", notifyCustomer: true } },
    { headers }
  );
  const cancelErrors = cancelRes.data?.data?.orderCancel?.orderCancelUserErrors ?? [];
  if (cancelErrors.length > 0) {
    console.error("Cancel errors:", cancelErrors);
  } else {
    console.log("✅ Order cancelled.");
  }
};
