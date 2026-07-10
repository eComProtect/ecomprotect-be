import { Router } from "express";
import { getOrders } from "@/controllers/orders/getorders.controller";
import { protectRoute, requireActiveOnboarding } from "@/middlewares/auth.middleware";
import { getRiskyOrders } from "@/controllers/orders/riskyorders.controller";
import { addFlag } from "@/controllers/orders/addflag.controller";
import { deleteFlag } from "@/controllers/orders/deleteflag.controller";
import { getCustomerRefundHistoryFromShopify } from "@/controllers/orders/getrefunds.controller";

const orderRouter = Router();

orderRouter.get("/orders", protectRoute, requireActiveOnboarding, getOrders);
orderRouter.get("/risky-orders", protectRoute, requireActiveOnboarding, getRiskyOrders);
orderRouter.post("/add-flag", protectRoute, requireActiveOnboarding, addFlag);
orderRouter.post("/delete-flag", protectRoute, requireActiveOnboarding, deleteFlag);
orderRouter.get(
  "/customer-refunds/:userId",
  protectRoute,
  requireActiveOnboarding,
  getCustomerRefundHistoryFromShopify
);

export default orderRouter;
