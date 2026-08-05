# eComProtect API Documentation

This document provides a comprehensive overview of the APIs available in the eComProtect backend and explains the core application flows.

## Table of Contents
1. [Application Flow](#application-flow)
2. [Authentication](#authentication)
3. [Orders API (`/api/order`)](#orders-api-apiorder)
4. [Customer API (`/api/customer`)](#customer-api-apicustomer)
5. [Settings API (`/api/settings`)](#settings-api-apisettings)
6. [Payment API (`/api/payment`)](#payment-api-apipayment)
7. [Webhooks API (`/api/webhook`)](#webhooks-api-apiwebhook)
8. [Reports API (`/api/reports`)](#reports-api-apireports)
9. [Activity API (`/api/activity`)](#activity-api-apiactivity)

---

## Application Flow

### 1. Merchant Onboarding & Setup
- **Signup**: Merchants register via `/api/auth/sign-up/email`, providing their Shopify store URL and contact information.
- **Plan Selection**: During onboarding, merchants select a subscription plan (monitored via `/api/payment`).
- **Approval**: New registrations require admin approval (unless auto-activation is enabled). Verification emails are sent to the admin.
- **Webhook Registration**: Upon successful signup/activation, the system automatically registers `orders/create` and `refunds/create` webhooks on the merchant's Shopify store using their API credentials.
- **Initialization**: Default risk settings (thresholds for lost parcels, etc.) are created for the new store.

### 2. Order & Risk Monitoring
- **Ingestion**: When an order is placed or a refund is issued on Shopify, a webhook is sent to `/api/webhook/orders/create` or `/api/webhook/refunds/create`.
- **Analysis**: The system analyzes the incoming data, checking if the customer (by email, phone, or IP) exists in the global database of flagged users or has a history of high refund rates across any connected store.
- **Visibility**: Merchants view these orders in their dashboard (`/user/order-management`), where they see risk flags and "risky" indicators.

### 3. Customer Management & Flagging
- **Manual Flagging**: Merchants can manually flag customers via `/api/order/add-flag` for specific reasons (e.g., fraudulent return, abusive behavior).
- **Network Effect**: Flagged customer data is shared (anonymized/aggregated) across the network, allowing other merchants to be warned if the same customer orders from them.
- **Blocking**: Merchants can block customers via `/api/customer/block-customer` to prevent future problematic interactions.

### 4. Admin Oversight
- **Dashboard**: Admins monitor system growth, store onboarding rates, and overall effectiveness of the risk detection system via `/api/reports`.
- **Store Management**: Admins can manage connected stores and review user registrations.

---

## Authentication

Managed via **Better-Auth** at the prefix `/api/auth`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/sign-up/email` | POST | Register a new merchant store. |
| `/api/auth/sign-in/email` | POST | Authenticate a merchant or admin. |
| `/api/auth/sign-out` | POST | Terminate the current session. |
| `/api/auth/verify-email` | GET | Verify a user's email address. |

---

## Orders API (`/api/order`)

Handles order retrieval, flagging, and external Shopify data fetching.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/orders` | GET | Fetches the list of orders for the authenticated store. |
| `/risky-orders` | GET | Retrieves orders identified as having high risk. |
| `/add-flag` | POST | Adds a manual risk flag to an order/customer. |
| `/delete-flag` | POST | Removes a risk flag. |
| `/customer-refunds/:userId` | GET | Fetches detailed refund history for a specific user from Shopify. |

---

## Customer API (`/api/customer`)

Advanced analytics and customer risk management.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/customers` | GET | Retrieves customer refund data across the entire store network. |
| `/block-customer` | POST | Manually block a customer email/IP. |
| `/unblock-customer` | POST | Remove a block from a customer. |
| `/total-flagged-customer` | GET | Summary of all flagged customers. |
| `/repeated-offenders` | GET | Identifies customers with multiple flags across different stores. |
| `/top-risky-ips` | GET | Lists IP addresses associated with high-risk behavior. |
| `/top-flagged-reason` | GET | Analytics on the most common reasons customers are flagged. |
| `/monthly-risk-incidents` | GET | Time-series data for risk incidents. |
| `/flagged-customer-store`| GET | Lists flagged customers and their associated stores. |

---

## Settings API (`/api/settings`)

Merchant-specific configuration for risk detection.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/fetch` | GET | Retrieve the current store's risk thresholds and settings. |
| `/create` | POST | Update or create risk settings (e.g., lost parcel threshold). |

---

## Billing

Subscription and billing are handled exclusively through the Shopify Billing API
(`/api/billing`) once a merchant installs the app on their store — there is no
separate payment endpoint.

---

## Webhooks API (`/api/webhook`)

Receivers for external Shopify events. *Note: These are called by Shopify, not the frontend.*

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/orders/create` | POST | Ingests new order data from Shopify and performs risk analysis. |
| `/refunds/create` | POST | Ingests new refund data and updates customer risk profiles. |

---

## Reports API (`/api/reports`)

Analytic endpoints for the Admin Dashboard.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/system-effectiveness`| GET | Metrics on how many fraudulent orders were caught. |
| `/onboarding` | GET | Statistics on new store registrations and approvals. |
| `/wide-network` | GET | Data on the total network size and shared risk intelligence. |

---

## Activity API (`/api/activity`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/logs` | GET | Fetches a log of recent system activities or merchant actions. |
