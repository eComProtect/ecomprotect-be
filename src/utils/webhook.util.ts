import axios from "axios";
import { env } from "@/utils/env.util";
import { logger } from "@/utils/logger.util";

type RestWebhookTopic =
  | "orders/create"
  | "refunds/create"
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact"
  | "app/uninstalled"
  | "app_subscriptions/update";

type RequiredWebhookKey =
  | "ORDERS_CREATE"
  | "REFUNDS_CREATE"
  | "CUSTOMERS_DATA_REQUEST"
  | "CUSTOMERS_REDACT"
  | "SHOP_REDACT"
  | "APP_UNINSTALLED"
  | "APP_SUBSCRIPTIONS_UPDATE";

interface RequiredWebhookDefinition {
  key: RequiredWebhookKey;
  topic: RestWebhookTopic;
  path: string;
}

interface ShopifyWebhookRecord {
  id: number;
  address: string;
  topic: string;
}

interface RegisteredWebhookResult {
  key: RequiredWebhookKey;
  topic: RestWebhookTopic;
  address: string;
  status: "created" | "existing";
  id?: number;
}

interface RequiredWebhookVerification {
  key: RequiredWebhookKey;
  topic: RestWebhookTopic;
  address: string;
  registered: boolean;
}

interface RequiredWebhookRegistrationSummary {
  registrations: RegisteredWebhookResult[];
  verification: RequiredWebhookVerification[];
  allRegistered: boolean;
}

const SHOPIFY_ADMIN_API_VERSION = "2025-07";

// NOTE: The GDPR/compliance topics (customers/data_request, customers/redact,
// shop/redact) are intentionally NOT registered here. Shopify does not accept them
// via the webhook API (it returns 404 "Could not find the webhook topic ...") — they
// are mandatory *compliance webhooks* configured in the Partner Dashboard
// (App setup → Compliance webhooks). Only operational webhooks are registered via API.
const requiredWebhookDefinitions: RequiredWebhookDefinition[] = [
  {
    key: "ORDERS_CREATE",
    topic: "orders/create",
    path: "/api/webhook/orders/create",
  },
  {
    key: "REFUNDS_CREATE",
    topic: "refunds/create",
    path: "/api/webhook/refunds/create",
  },
  {
    key: "APP_UNINSTALLED",
    topic: "app/uninstalled",
    path: "/api/webhook/app/uninstalled",
  },
  {
    key: "APP_SUBSCRIPTIONS_UPDATE",
    topic: "app_subscriptions/update",
    path: "/api/webhook/app/subscriptions-update",
  },
];

function buildWebhookAddress(path: string): string {
  return new URL(path, env.BACKEND_DOMAIN).toString();
}

function shopifyHeaders(accessToken: string) {
  return {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };
}

async function fetchRegisteredWebhooks(
  shopUrl: string,
  accessToken: string
): Promise<ShopifyWebhookRecord[]> {
  const response = await axios.get(
    `${shopUrl}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/webhooks.json`,
    {
      headers: shopifyHeaders(accessToken),
    }
  );

  return Array.isArray(response.data?.webhooks) ? response.data.webhooks : [];
}

async function ensureWebhookRegistered(
  shopUrl: string,
  accessToken: string,
  webhook: RequiredWebhookDefinition,
  existingWebhooks: ShopifyWebhookRecord[]
): Promise<RegisteredWebhookResult> {
  const address = buildWebhookAddress(webhook.path);
  const existing = existingWebhooks.find(
    (item) => item.topic === webhook.topic && item.address === address
  );

  if (existing) {
    return {
      key: webhook.key,
      topic: webhook.topic,
      address,
      status: "existing",
      id: existing.id,
    };
  }

  const response = await axios.post(
    `${shopUrl}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/webhooks.json`,
    {
      webhook: {
        topic: webhook.topic,
        address,
        format: "json",
      },
    },
    {
      headers: shopifyHeaders(accessToken),
    }
  );

  const created = response.data?.webhook;

  return {
    key: webhook.key,
    topic: webhook.topic,
    address,
    status: "created",
    id: created?.id,
  };
}

export async function registerRequiredWebhooks(
  shopUrl: string,
  accessToken: string
): Promise<RequiredWebhookRegistrationSummary> {
  const existingWebhooks = await fetchRegisteredWebhooks(shopUrl, accessToken);
  const registrations: RegisteredWebhookResult[] = [];

  for (const webhook of requiredWebhookDefinitions) {
    const registration = await ensureWebhookRegistered(
      shopUrl,
      accessToken,
      webhook,
      existingWebhooks
    );

    registrations.push(registration);

    if (registration.id) {
      existingWebhooks.push({
        id: registration.id,
        topic: registration.topic,
        address: registration.address,
      });
    }
  }

  const refreshedWebhooks = await fetchRegisteredWebhooks(shopUrl, accessToken);
  const verification = requiredWebhookDefinitions.map((webhook) => {
    const address = buildWebhookAddress(webhook.path);
    const registered = refreshedWebhooks.some(
      (item) => item.topic === webhook.topic && item.address === address
    );

    return {
      key: webhook.key,
      topic: webhook.topic,
      address,
      registered,
    };
  });

  const allRegistered = verification.every((item) => item.registered);

  logger.info(
    `[Webhook] Registration summary: ${JSON.stringify(
      {
        shopUrl,
        registrations,
        verification,
        allRegistered,
      },
      null,
      2
    )}`
  );

  return {
    registrations,
    verification,
    allRegistered,
  };
}

export async function registerOrderWebhook(
  shopUrl: string,
  accessToken: string
): Promise<RegisteredWebhookResult> {
  const existingWebhooks = await fetchRegisteredWebhooks(shopUrl, accessToken);
  return ensureWebhookRegistered(
    shopUrl,
    accessToken,
    requiredWebhookDefinitions[0],
    existingWebhooks
  );
}

export async function registerRefundWebhook(
  shopUrl: string,
  accessToken: string
): Promise<RegisteredWebhookResult> {
  const existingWebhooks = await fetchRegisteredWebhooks(shopUrl, accessToken);
  return ensureWebhookRegistered(
    shopUrl,
    accessToken,
    requiredWebhookDefinitions[1],
    existingWebhooks
  );
}
