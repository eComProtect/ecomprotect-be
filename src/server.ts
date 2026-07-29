import { assignSocketToReqIO } from "@/middlewares/socket.middleware";
import { connAuthBridge } from "@/middlewares/socket.middleware";
import { throttle } from "./middlewares/throttle.middleware";
import { registerEvents } from "@/utils/registerevents.util";
import unknownRoutes from "@/routes/unknown.routes";
import { swagger } from "@/configs/swagger.config";
import { toNodeHandler } from "better-auth/node";
import { logger } from "@/utils/logger.util";
import cors, { CorsOptions } from "cors";
import cookieParser from "cookie-parser";
import { env } from "./utils/env.util";
import { createServer } from "http";
import { Server } from "socket.io";
import "@/types/declaration.types";
import { auth } from "./lib/auth";
import { config } from "dotenv";
import express from "express";
import morgan from "morgan";
import helmet from "helmet";
import paymentRouter from "./routes/payment.route";
import userRouter from "./routes/user.route";
import settingsRouter from "./routes/settings.route";
import webhookRouter from "./routes/webhook.route";
import customerRouter from "./routes/customer.route";
import orderRouter from "./routes/order.route";
import notificationRouter from "./routes/notification.route";
import reportsRouter from "./routes/reports.route";
import activityRouter from "./routes/activity.route";
import shopifyRouter from "./routes/shopify.route";
import shopifyCredentialsRouter from "./routes/shopifycredentials.route";
import billingRouter from "./routes/billing.route";
import onboardingRouter from "./routes/onboarding.route";
import staffRouter from "./routes/staff.route";
import { startPendingRiskActionsScheduler } from "@/jobs/pendingriskactions.job";

config();

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT) || 3001;

const corsOptions: CorsOptions = {
  origin: env.FRONTEND_DOMAIN,
  credentials: true,
};

const io = new Server(httpServer, {
  cors: corsOptions,
});

swagger(app);

// Schema sync is handled manually via `npm run dbpush` (drizzle-kit push),
// not on app startup — see package.json.

// Helmet, configured so Shopify Admin can embed this app in an iframe.
// - frame-ancestors allows framing only by Shopify (any *.myshopify.com store + admin.shopify.com)
// - frameguard:false removes the default `X-Frame-Options: DENY`, which would otherwise
//   block embedding entirely (CSP frame-ancestors supersedes it in modern browsers).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "frame-ancestors": ["https://*.myshopify.com", "https://admin.shopify.com"],
      },
    },
    frameguard: false,
  })
);
io.on("connection", registerEvents);
app.use(express.static("public"));
app.use(assignSocketToReqIO(io));
app.use(express.static("dist"));
app.use(cors(corsOptions));
app.use(cookieParser());
io.use(connAuthBridge);
app.set("trust proxy", true);

app.use(morgan("dev"));
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(throttle("default"));
// Mounted before express.json(): webhook routes verify Shopify's HMAC over the
// raw request body (via their own express.raw() middleware, see
// webhook.route.ts). If the global JSON parser below ran first, it would
// already have consumed the body stream, leaving raw() with nothing to sign
// against and every webhook's HMAC check failing.
app.use("/api/webhook", webhookRouter);
app.use(express.json());
app.use("/api/payment", paymentRouter);
app.use("/api/user", userRouter);
app.use("/api/order", orderRouter);
app.use("/api/customer", customerRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/activity", activityRouter);
app.use("/api/billing", billingRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/staff", staffRouter);
// Custom-app credential connection (client_credentials grant). Under /api so
// the frontend's axios instance reaches it; the OAuth router below stays at the
// root because its URLs are registered with Shopify.
app.use("/api/shopify", shopifyCredentialsRouter);
app.use("/shopify", shopifyRouter);

app.use(unknownRoutes);

httpServer.listen(port as number, () => {
  logger.info(`server is running on port: ${port}`);
  logger.info(`Docs are available at \n/api/docs and /api/docs-json`);
});

startPendingRiskActionsScheduler(io);
