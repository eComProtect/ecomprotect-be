import { Router } from "express";
import { protectRoute, requireActiveOnboarding } from "@/middlewares/auth.middleware";
import { getNotificationController } from "@/controllers/notification/getnotificaiton.controller";
import { markNotificationSeen } from "@/controllers/notification/marknotification.controller";
import {
  getPushSubscriptionStatusController,
  getVapidPublicKeyController,
  savePushSubscriptionController,
} from "@/controllers/notification/pushsubscription.controller";

const notificationRouter = Router();

notificationRouter.get(
  "/get-notifications",
  protectRoute,
  requireActiveOnboarding,
  getNotificationController
);

notificationRouter.put(
  "/mark-as-read/:id",
  protectRoute,
  requireActiveOnboarding,
  markNotificationSeen
);

notificationRouter.get("/vapid-public-key", getVapidPublicKeyController);

// Deliberately no protectRoute here — the standalone /enable-notifications
// tab (opened outside Shopify's iframe to get a real permission prompt) has
// no session of its own. It identifies the store via a `shop` field instead;
// see resolveStoreForPushSubscription in the controller.
notificationRouter.post("/push-subscription", savePushSubscriptionController);

notificationRouter.get(
  "/push-subscription/status",
  protectRoute,
  getPushSubscriptionStatusController
);

export default notificationRouter;
