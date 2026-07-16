import { Router } from "express";
import { getOrders } from "@/controllers/orders/getorders.controller";
import { protectRoute, requireActiveOnboarding } from "@/middlewares/auth.middleware";
import { getRiskyOrders } from "@/controllers/orders/riskyorders.controller";
import { addFlag } from "@/controllers/orders/addflag.controller";
import { deleteFlag } from "@/controllers/orders/deleteflag.controller";
import { getCustomerRefundHistoryFromShopify } from "@/controllers/orders/getrefunds.controller";
import {
  listPendingActions,
  cancelPendingAction,
} from "@/controllers/orders/pendingaction.controller";
import { getWaiverInfo, contestOrder } from "@/controllers/orders/waiver.controller";

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

orderRouter.get("/pending-actions", protectRoute, requireActiveOnboarding, listPendingActions);
orderRouter.post(
  "/cancel-pending-action",
  protectRoute,
  requireActiveOnboarding,
  cancelPendingAction
);

// Deliberately no protectRoute — the customer has no account/session here.
// The signed token in the query/body (bound to this exact orderId) is what
// authorizes access; see waiver.controller.ts.
orderRouter.get("/:orderId/waiver-info", getWaiverInfo);
orderRouter.post("/:orderId/contest", contestOrder);

export default orderRouter;
