import { Router } from "express";
import { protectRoute } from "@/middlewares/auth.middleware";
import {
  billingStatusController,
  cancelSubscriptionController,
  plansController,
  subscribeController,
} from "@/controllers/billing.controller";

const billingRouter = Router();

billingRouter.get("/plans", protectRoute, plansController);
billingRouter.get("/status", protectRoute, billingStatusController);
billingRouter.post("/subscribe", protectRoute, subscribeController);
billingRouter.post("/cancel", protectRoute, cancelSubscriptionController);

export default billingRouter;
