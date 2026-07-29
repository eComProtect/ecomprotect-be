import { Router } from "express";
import { subscriptionController } from "@/controllers/payment.controller";
import { StripePayment } from "@/controllers/payments/stripe.controller";
import { protectRoute } from "@/middlewares/auth.middleware";

const paymentRouter = Router();

paymentRouter.post("/create", subscriptionController);
// protectRoute so the checkout session can be tied to a real store (see
// stripe.controller.ts) — the webhook has no other way to know who paid.
paymentRouter.post("/create-stripe", protectRoute, StripePayment);

export default paymentRouter;
