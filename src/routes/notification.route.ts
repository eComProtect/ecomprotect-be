import { Router } from "express";
import { protectRoute, requireActiveOnboarding } from "@/middlewares/auth.middleware";
import { getNotificationController } from "@/controllers/notification/getnotificaiton.controller";
import { markNotificationSeen } from "@/controllers/notification/marknotification.controller";
import {
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

notificationRouter.post(
  "/push-subscription",
  protectRoute,
  requireActiveOnboarding,
  savePushSubscriptionController
);

export default notificationRouter;
