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
 * Unlike Stripe, Shopify takes the amount inline at subscription-create time, so there
 * are no pre-created price IDs — this matrix is the single source of truth.
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
  /**
   * Stripe Price IDs for the same matrix — the website's payment path. Kept
   * beside the amounts so the two can't disagree, and resolved server-side so
   * the browser never chooses which price it is charged (it previously sent a
   * priceId of its own choosing straight into checkout.sessions.create).
   */
  stripePrices: Record<OrderTier | "default", string>;
  available: boolean;
}

/**
 * Price IDs differ per Stripe mode (the defaults below are test-mode IDs), so
 * each is overridable by env var — going live means setting these, not editing
 * code. Read via process.env rather than env.util so they stay optional, same
 * as SHOPIFY_BILLING_TEST below.
 */
const priceId = (envKey: string, fallback: string): string =>
  process.env[envKey]?.trim() || fallback;

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
    stripePrices: {
      "0-300": priceId(
        "STRIPE_PRICE_INSIGHT_0_300",
        "price_1TybvOGyMcbTbaq2bziNRi0J"
      ),
      "301-2,000": priceId(
        "STRIPE_PRICE_INSIGHT_301_2000",
        "price_1TybwCGyMcbTbaq2P9Mjbkam"
      ),
      "2,001-5,000": priceId(
        "STRIPE_PRICE_INSIGHT_2001_5000",
        "price_1SCiSQHCrwRt7F86SYBzh0v0"
      ),
      default: priceId(
        "STRIPE_PRICE_INSIGHT_DEFAULT",
        "price_1SCiNzHCrwRt7F86dQ21B142"
      ),
    },
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
    stripePrices: {
      "0-300": priceId(
        "STRIPE_PRICE_VISION_0_300",
        "price_1SCiKeHCrwRt7F86pRVFlUE5"
      ),
      "301-2,000": priceId(
        "STRIPE_PRICE_VISION_301_2000",
        "price_1SCiQTHCrwRt7F86iFHMRxNu"
      ),
      "2,001-5,000": priceId(
        "STRIPE_PRICE_VISION_2001_5000",
        "price_1SCiS3HCrwRt7F86OlCRIROT"
      ),
      default: priceId(
        "STRIPE_PRICE_VISION_DEFAULT",
        "price_1SCiKeHCrwRt7F86pRVFlUE5"
      ),
    },
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
    stripePrices: {
      "0-300": priceId(
        "STRIPE_PRICE_SHIELD_0_300",
        "price_1SCiPTHCrwRt7F869QlJmX3W"
      ),
      "301-2,000": priceId(
        "STRIPE_PRICE_SHIELD_301_2000",
        "price_1SCiRUHCrwRt7F86k3IbSlHW"
      ),
      "2,001-5,000": priceId(
        "STRIPE_PRICE_SHIELD_2001_5000",
        "price_1SCiSnHCrwRt7F86OUxeWrZ3"
      ),
      default: priceId(
        "STRIPE_PRICE_SHIELD_DEFAULT",
        "price_1SCiPTHCrwRt7F869QlJmX3W"
      ),
    },
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

/**
 * Resolves the Stripe Price ID for a package + the merchant's order range.
 * Returns null for an unknown or unpurchasable package, so a caller can reject
 * the request rather than opening checkout for something that isn't on sale.
 */
export function resolveStripePriceId(
  planName: string,
  ordersPerMonth: string | null | undefined
): { plan: BillingPlan; stripePriceId: string; amount: number } | null {
  const plan = BILLING_PLANS.find((p) => p.name === planName);
  if (!plan || !plan.available) return null;

  const tier = ordersPerMonth as OrderTier;
  const inMatrix = tier in plan.prices;

  return {
    plan,
    stripePriceId: inMatrix ? plan.stripePrices[tier] : plan.stripePrices.default,
    amount: inMatrix ? plan.prices[tier] : plan.prices.default,
  };
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
