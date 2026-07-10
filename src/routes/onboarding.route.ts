import { Router } from "express";
import { getOnboardingStatusController } from "@/controllers/onboarding/onboarding.controller";

const onboardingRouter = Router();

onboardingRouter.get("/status", getOnboardingStatusController);

export default onboardingRouter;
