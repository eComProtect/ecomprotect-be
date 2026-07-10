import { Router } from "express";
import { protectRoute } from "@/middlewares/auth.middleware";
import {
  completeSignupController,
  getOnboardingStatusController,
} from "@/controllers/onboarding/onboarding.controller";

const onboardingRouter = Router();

onboardingRouter.get("/status", getOnboardingStatusController);
onboardingRouter.post("/signup", protectRoute, completeSignupController);

export default onboardingRouter;
