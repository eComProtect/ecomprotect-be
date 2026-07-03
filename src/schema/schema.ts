import {
  text,
  pgTable,
  integer,
  varchar,
  boolean,
  timestamp,
  numeric,
  ReferenceConfig,
  json,
} from "drizzle-orm/pg-core";
// import { createInsertSchema } from "drizzle-zod";
import { createId } from "@paralleldrive/cuid2";
import { relations } from "drizzle-orm";

const timeStamps = {
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").$onUpdateFn(() => new Date()),
};

type UUIDOptions = Exclude<Parameters<typeof varchar>[1], undefined>;

const uuid = (columnName?: string, options?: UUIDOptions) =>
  varchar(columnName ?? "id", options).$defaultFn(() => createId());

const foreignkeyRef = (
  columnName: string,
  refColumn: ReferenceConfig["ref"],
  actions?: ReferenceConfig["actions"]
) => varchar(columnName, { length: 128 }).references(refColumn, actions);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role").default("subadmin"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  company_name: text("company_name"),
  mobile_number: text("mobile_number"),
  company_registration_number: text("company_registration_number"),
  average_orders_per_month: text("average_orders_per_month"),
  plan: text("plan"),
  package: text("package"),
  shopify_api_key: text("shopify_api_key"),
  shopify_access_token: text("shopify_access_token"),
  shopify_url: text("shopify_url"),
  shopify_token_expires_at: timestamp("shopify_token_expires_at"),
  totalSearches: integer("total_searches").default(0),
});

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name"),
  firstName: text("first_name"),
  surname: text("surname"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  postCode: text("post_code"),
  totalRefunded: numeric("total_refunded", { precision: 12, scale: 2 }),
  totalOrders: integer("total_orders"),
  riskLevel: integer("risk_level"),
  flagged: boolean("flagged"),
  riskReason: varchar("risk_reason"),
  refundsFromStores: integer("refunds_from_stores"),
  riskySince: timestamp("risky_since"),
  storeId: foreignkeyRef("store_id", () => users.id, { onDelete: "cascade" }),
  blocked: boolean("blocked").default(false),
  ip: varchar("ip"),
  tags: varchar("tags", { length: 255 }),
  ...timeStamps,
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull(),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull(),

  customerEmail: varchar("customer_email", { length: 150 }),
  customerPhone: varchar("customer_phone", { length: 20 }),
  displayFulfillmentStatus: varchar("display_fulfillment_status", {
    length: 50,
  }),
  fulfillmentStatus: varchar("fulfillment_status", { length: 50 }),
  trackingNumber: varchar("tracking_number", { length: 255 }),
  trackingCompany: varchar("tracking_company", { length: 255 }),
  deliveredAt: timestamp("delivered_at"),
  disputeOpened: boolean("dispute_opened").default(false).notNull(),
  manualFlag: boolean("manual_flag").default(false),
  flagged: boolean("flagged").default(false),
  flagReason: text("flag_reason"),
  autoCancel: boolean("auto_cancel").default(false),
  riskLevel: varchar("risk_level", { length: 50 }),
  totalRefunded: numeric("total_refunded", { precision: 12, scale: 2 }),
  riskRecommendation: varchar("risk_recommendation", { length: 50 }),
  customerId: foreignkeyRef("customerId", () => customers.id, {
    onDelete: "cascade",
  }),
  ...timeStamps,
});

export const orderItems = pgTable("order_items", {
  id: text("id").primaryKey(),
  orderId: foreignkeyRef("order_id", () => orders.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  quantity: integer("quantity").notNull(),
  // price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  ...timeStamps,
});

export const fulfillmentOrders = pgTable("fulfillment_orders", {
  id: text("id").primaryKey(),
  orderId: foreignkeyRef("order_id", () => orders.id, { onDelete: "cascade" }),

  status: varchar("status", { length: 50 }),
  requestStatus: varchar("request_status", { length: 50 }),
  fulfillAt: timestamp("fulfill_at"),
  fulfillBy: timestamp("fulfill_by"),

  deliveryMethod: varchar("delivery_method", { length: 50 }),
  deliveryMinDate: timestamp("delivery_min_date"),
  deliveryMaxDate: timestamp("delivery_max_date"),

  destCity: varchar("dest_city", { length: 100 }),
  destCountry: varchar("dest_country", { length: 5 }),
  destZip: varchar("dest_zip", { length: 20 }),

  onHoldReason: text("on_hold_reason"),

  ...timeStamps,
});

export const customerRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
}));

// TODO: Relations B/W orders and orderLineItems
export const orderRelations = relations(orders, ({ many, one }) => ({
  customers: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  orderItems: many(orderItems),
  fulfillmentOrders: many(fulfillmentOrders),
}));

export const fulfillmentOrdersRelations = relations(
  fulfillmentOrders,
  ({ one }) => ({
    order: one(orders, {
      fields: [fulfillmentOrders.orderId],
      references: [orders.id],
    }),
  })
);

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));

// *This is the schema of settings
export const settings = pgTable("settings", {
  id: uuid("id").primaryKey(),
  storeId: foreignkeyRef("store_id", () => users.id, {
    onDelete: "cascade",
  }).notNull(),

  lostParcelThreshold: integer("lost_parcel_threshold").default(3).notNull(),
  lostParcelPeriod: integer("lost_parcel_period").default(1).notNull(),
  lossRateThreshold: integer("loss_rate_threshold"),

  matchSensitivity: text("match_sensitivity"),
  primaryAction: varchar("primary_action"),
  requireESignature: boolean("require_signature").default(false),
  forceCourierSignedDelivery: boolean("force_signed_delivery").default(false),
  photoOnDelivery: boolean("photo_on_delivery").default(false),
  sendCancellationEmail: boolean("send_cancellation_email").default(false),
  includeWavierLink: boolean("include_wavier_link").default(false),

  emailNotificationsEnabled: boolean("email_notifications_enabled").default(true),
  notificationEmail: varchar("notification_email", { length: 255 }).default('info@example.com'),
  includeOrderDetails: boolean("include_order_details").default(true),
  includeReasonForFlag: boolean("include_reason_for_flag").default(true),
  includeRecommendedAction: boolean("include_recommended_action").default(true),
  autoHoldRiskyOrders: boolean("auto_hold_risky_orders").default(false),

  exclusionList: text("exclusion_list"), // JSON string of exclusion items
  actionDelayHours: integer("action_delay_hours").default(0), // Hours to delay automatic cancellations

  ...timeStamps,
});

// export const settingsRelations = relations(settings, ({ many }) => ({
//   settings: many(settings),
// }));

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  storeId: uuid("store_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  customerId: uuid("customer_id").references(() => customers.id, {
    onDelete: "set null",
  }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  meta: json("meta").$type<{
    orderId?: string;
    orderName?: string;
    reasons?: string[];
    totalAmount?: string;
    currency?: string;
  }>(),
  read: boolean("read").default(false),
  ...timeStamps,
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey(),
  storeId: text("store_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  endpoint: text("endpoint").notNull(),
  p256dhKey: text("p256dh_key").notNull(),
  authKey: text("auth_key").notNull(),
  ...timeStamps,
});

export const activities = pgTable("activities", {
  id: varchar("id", { length: 128 })
    .$defaultFn(() => createId())
    .primaryKey(),
  action: text("action").notNull(),
  for: varchar("for").notNull(),
  storeId: varchar("store_id", { length: 128 }).references(() => users.id, {
    onDelete: "cascade",
  }),
  customerId: varchar("customer_id", { length: 128 }).references(
    () => customers.id,
    { onDelete: "set null" }
  ),
  orderId: varchar("order_id", { length: 128 }).references(() => orders.id, {
    onDelete: "set null",
  }),
  meta: json("meta").$type<{
    ip?: string;
    reason?: string;
    previousValue?: string;
    newValue?: string;
    [key: string]: any;
  }>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(
    () => /* @__PURE__ */ new Date()
  ),
  updatedAt: timestamp("updated_at").$defaultFn(
    () => /* @__PURE__ */ new Date()
  ),
});

export const throttleinsight = pgTable("throttle_insight", {
  waitTime: integer("wait_time").notNull(),
  msBeforeNext: integer("ms_before_next").notNull(),
  endPoint: varchar("end_point", { length: 225 }),
  pointsAllotted: integer("allotted_points").notNull(),
  consumedPoints: integer("consumed_points").notNull(),
  remainingPoints: integer("remaining_points").notNull(),
  key: varchar("key", { length: 225 }).primaryKey().notNull(),
  isFirstInDuration: boolean("is_first_in_duration").notNull(),
});
