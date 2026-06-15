import { Router } from "express";
import { protectRoute } from "@/middlewares/auth.middleware";
import {
  billingStatusController,
  plansController,
  subscribeController,
} from "@/controllers/billing.controller";

const billingRouter = Router();

billingRouter.get("/plans", protectRoute, plansController);
billingRouter.get("/status", protectRoute, billingStatusController);
billingRouter.post("/subscribe", protectRoute, subscribeController);

export default billingRouter;
