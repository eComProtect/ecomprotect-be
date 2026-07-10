import {
  getRiskRelevantReturns,
  hasLossEvents,
  type ShopifyReturnsValue,
} from "@/service/shopify-loss-events.service";

interface RiskSettings {
  createdAt: Date | null;
  updatedAt: Date | null;
  id: string;
  storeId: string;
  lostParcelThreshold: number;
  lostParcelPeriod: number;
  lossRateThreshold: number | null;
  matchSensitivity: string | null;
}

interface CustomerOrder {
  node: {
    createdAt: string;
    refunds: { createdAt: string; id: string }[];
    returns?: ShopifyReturnsValue;
  };
}

interface CustomerNode {
  orders: {
    edges: CustomerOrder[];
  };
}

const DEFAULT_SETTINGS: Pick<
  RiskSettings,
  "lostParcelThreshold" | "lostParcelPeriod" | "lossRateThreshold"
> = {
  lostParcelThreshold: 3,
  lostParcelPeriod: 1,
  lossRateThreshold: null,
};

export const calculateCustomerRisk = (
  customer: CustomerNode,
  settings: RiskSettings | null | undefined
): { isFlagged: boolean; riskLevel: number; riskReason: string } => {
  const { lostParcelThreshold, lostParcelPeriod, lossRateThreshold } = {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
  };

  const now = new Date();
  const periodStartDate = new Date(
    new Date().setMonth(now.getMonth() - lostParcelPeriod)
  );

  const lossEventsInPeriod = customer.orders.edges.flatMap((order) => {
    const refundEvents = order.node.refunds.filter(
      (refund) => new Date(refund.createdAt) >= periodStartDate
    );
    const returnEvents = getRiskRelevantReturns(order.node).filter((returnRecord) => {
      if (!returnRecord.createdAt) {
        return false;
      }

      return new Date(returnRecord.createdAt) >= periodStartDate;
    });

    return [...refundEvents, ...returnEvents];
  });

  if (lossEventsInPeriod.length >= lostParcelThreshold) {
    return {
      isFlagged: true,
      riskLevel: 100,
      riskReason: `Exceeded threshold: ${lossEventsInPeriod.length} refund/return events in the last ${lostParcelPeriod} months.`,
    };
  }

  const totalOrders = customer.orders.edges.length;

  if (totalOrders === 0) {
    return {
      isFlagged: false,
      riskLevel: 0,
      riskReason: "No orders found for this customer.",
    };
  }

  const ordersWithLossEvents = customer.orders.edges.filter((order) =>
    hasLossEvents(order.node)
  );
  const refundRate = (ordersWithLossEvents.length / totalOrders) * 100;

  if (typeof lossRateThreshold === "number" && lossRateThreshold > 0) {
    if (refundRate >= lossRateThreshold) {
      return {
        isFlagged: true,
        riskLevel: Math.round(refundRate),
        riskReason: `Exceeded rate: ${refundRate.toFixed(
          0
        )}% refund/return rate above ${lossRateThreshold}% threshold.`,
      };
    }
    return {
      isFlagged: false,
      riskLevel: Math.round(refundRate),
      riskReason: `Refund/return rate of ${refundRate.toFixed(
        0
      )}% is within the safe limit.`,
    };
  }

  return {
    isFlagged: false,
    riskLevel: 0,
    riskReason:
      "Within time-based refund/return limits. No loss rate threshold set.",
  };
};
