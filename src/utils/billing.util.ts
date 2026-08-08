import axios from "axios";
import { logger } from "@/utils/logger.util";

/**
 * Shopify Billing API helpers (recurring app subscriptions).
 *
 * Pricing scales on two axes: the package (ECP Insight / Vision / Shield) and the
 * merchant's self-reported order volume (users.average_orders_per_month). The numbers
 * below mirror the existing pricing in the frontend signup flow exactly — including the
 * fallback amounts used for "5000+" / unknown ranges, which the client asked to keep.
 *
 * Shopify takes the amount inline at subscription-create time, so there are no
 * pre-created price IDs — this matrix is the single source of truth.
 */

const SHOPIFY_ADMIN_API_VERSION = "2025-07";
const BILLING_CURRENCY = "GBP";
const BILLING_INTERVAL = "EVERY_30_DAYS"; // monthly recurring

export type OrderTier = "0-300" | "301-2,000" | "2,001-5,000";

export interface BillingPlan {
  name: string;
  description: string;
  features: string[];
  /** Per-order-tier monthly amount; `default` covers "5000+"/unknown (kept as-is). */
  prices: Record<OrderTier | "default", number>;
  available: boolean;
}

/**
 * Feature gating by plan tier. Each plan's `description` in BILLING_PLANS
 * markets these exact capabilities (e.g. "Lost Data + % Loss Rate") — until
 * now nothing in the codebase actually enforced that, so every merchant got
 * every feature regardless of which plan they paid for.
 *
 * "waiverWorkflow" is Shield-only, and Shield is currently unpurchasable
 * (available: false in BILLING_PLANS) — that's intentional, matching the
 * marketing copy; the feature stays fully gated off for everyone until
 * Shield is actually offered.
 */
export type PlanFeature = "lossRateThreshold" | "waiverWorkflow";

const PLAN_FEATURES: Record<string, PlanFeature[]> = {
  "ECP Insight": [],
  "ECP Vision": ["lossRateThreshold"],
  "ECP Shield": ["lossRateThreshold", "waiverWorkflow"],
};

/** Whether a store's current package includes a given gated feature. */
export function planHasFeature(
  packageName: string | null | undefined,
  feature: PlanFeature
): boolean {
  if (!packageName) return false;
  return PLAN_FEATURES[packageName]?.includes(feature) ?? false;
}

export const BILLING_PLANS: BillingPlan[] = [
  {
    name: "ECP Insight",
    description: "Lost Data Access Only",
    features: [
      "Access to lost data insights",
      "Basic analytics dashboard",
      "Email support",
    ],
    prices: { "0-300": 399, "301-2,000": 799, "2,001-5,000": 1499, default: 399 },
    available: true,
  },
  {
    name: "ECP Vision",
    description: "Lost Data + % Loss Rate",
    features: [
      "All features from ECP Insight",
      "Detailed loss rate percentage",
      "Priority email support",
    ],
    prices: { "0-300": 299, "301-2,000": 699, "2,001-5,000": 1249, default: 399 },
    available: true,
  },
  {
    name: "ECP Shield",
    description: "Lost Data + % Loss Rate + Waiver Workflow",
    features: [
      "All features from ECP Vision",
      "Automated waiver workflow",
      "Dedicated account manager",
    ],
    prices: { "0-300": 499, "301-2,000": 899, "2,001-5,000": 1749, default: 499 },
    available: false,
  },
];

/** Resolves the monthly amount for a package + the merchant's order range. */
export function resolvePlanAmount(
  planName: string,
  ordersPerMonth: string | null | undefined
): { plan: BillingPlan; amount: number } | null {
  const plan = BILLING_PLANS.find((p) => p.name === planName);
  if (!plan) return null;

  const tier = ordersPerMonth as OrderTier;
  const amount =
    tier in plan.prices ? plan.prices[tier] : plan.prices.default;

  return { plan, amount };
}

/** Plans annotated with the resolved price for a specific merchant (for the UI). */
export function plansForMerchant(ordersPerMonth: string | null | undefined) {
  return BILLING_PLANS.map((plan) => {
    const tier = ordersPerMonth as OrderTier;
    const price = tier in plan.prices ? plan.prices[tier] : plan.prices.default;
    return {
      name: plan.name,
      description: plan.description,
      features: plan.features,
      price,
      currency: BILLING_CURRENCY,
      available: plan.available,
    };
  });
}

/** Test charges (no real money) everywhere except production, unless overridden. */
export function isBillingTest(): boolean {
  const override = process.env.SHOPIFY_BILLING_TEST;
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function graphqlEndpoint(shopUrl: string): string {
  // shopUrl may be stored as "https://shop.myshopify.com" or "shop.myshopify.com".
  const host = shopUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
}

interface CreateSubscriptionResult {
  confirmationUrl: string;
  subscriptionId: string;
}

export async function createAppSubscription(params: {
  shopUrl: string;
  accessToken: string;
  planName: string;
  amount: number;
  returnUrl: string;
  trialDays?: number;
}): Promise<CreateSubscriptionResult> {
  const { shopUrl, accessToken, planName, amount, returnUrl, trialDays } = params;

  const mutation = `
    mutation AppSubscriptionCreate(
      $name: String!
      $returnUrl: URL!
      $test: Boolean
      $trialDays: Int
      $lineItems: [AppSubscriptionLineItemInput!]!
    ) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        test: $test
        trialDays: $trialDays
        lineItems: $lineItems
      ) {
        userErrors { field message }
        confirmationUrl
        appSubscription { id status }
      }
    }
  `;

  const variables = {
    name: planName,
    returnUrl,
    test: isBillingTest(),
    trialDays: trialDays ?? 0,
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount, currencyCode: BILLING_CURRENCY },
            interval: BILLING_INTERVAL,
          },
        },
      },
    ],
  };

  const response = await axios.post(
    graphqlEndpoint(shopUrl),
    { query: mutation, variables },
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  const payload = response.data?.data?.appSubscriptionCreate;
  const topErrors = response.data?.errors;

  if (topErrors) {
    logger.error(`[Billing] GraphQL errors: ${JSON.stringify(topErrors)}`);
    throw new Error("Shopify rejected the billing request.");
  }

  if (payload?.userErrors?.length) {
    logger.error(`[Billing] userErrors: ${JSON.stringify(payload.userErrors)}`);
    throw new Error(
      payload.userErrors.map((e: { message: string }) => e.message).join("; ")
    );
  }

  if (!payload?.confirmationUrl) {
    throw new Error("Shopify did not return a confirmation URL.");
  }

  return {
    confirmationUrl: payload.confirmationUrl,
    subscriptionId: payload.appSubscription?.id ?? "",
  };
}

export interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
}

export async function getActiveSubscriptions(
  shopUrl: string,
  accessToken: string
): Promise<ActiveSubscription[]> {
  const query = `
    {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          test
        }
      }
    }
  `;

  const response = await axios.post(
    graphqlEndpoint(shopUrl),
    { query },
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  const subs =
    response.data?.data?.currentAppInstallation?.activeSubscriptions;
  return Array.isArray(subs) ? subs : [];
}

/**
 * Cancels a merchant's active app subscription via Shopify's Billing API.
 * The app/subscriptions-update webhook (subscription.webhook.ts) is what
 * actually flips onboardingStatus back to locked once Shopify confirms the
 * cancellation — this call just requests it.
 */
export async function cancelAppSubscription(
  shopUrl: string,
  accessToken: string,
  subscriptionId: string
): Promise<void> {
  const mutation = `
    mutation AppSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription { id status }
        userErrors { field message }
      }
    }
  `;

  const response = await axios.post(
    graphqlEndpoint(shopUrl),
    { query: mutation, variables: { id: subscriptionId } },
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  const payload = response.data?.data?.appSubscriptionCancel;
  const topErrors = response.data?.errors;

  if (topErrors) {
    logger.error(`[Billing] Cancel GraphQL errors: ${JSON.stringify(topErrors)}`);
    throw new Error("Shopify rejected the cancellation request.");
  }

  if (payload?.userErrors?.length) {
    logger.error(`[Billing] Cancel userErrors: ${JSON.stringify(payload.userErrors)}`);
    throw new Error(
      payload.userErrors.map((e: { message: string }) => e.message).join("; ")
    );
  }
}
