import { Router } from "express";
import { protectRoute } from "@/middlewares/auth.middleware";
import {
  connectShopifyCredentialsController,
  getShopifyCredentialsStatusController,
} from "@/controllers/shopify/connectcredentials.controller";

/**
 * Mounted at /api/shopify — distinct from the root-level /shopify router
 * (shopify.route.ts), which handles the OAuth install/callback pair and must
 * stay outside /api because its URLs are registered with Shopify.
 *
 * Deliberately behind protectRoute only, not requireActiveOnboarding: a store
 * connecting its credentials is by definition not active yet.
 */
const shopifyCredentialsRouter = Router();

shopifyCredentialsRouter.get(
  "/credentials",
  protectRoute,
  getShopifyCredentialsStatusController
);

shopifyCredentialsRouter.post(
  "/credentials",
  protectRoute,
  connectShopifyCredentialsController
);

export default shopifyCredentialsRouter;
