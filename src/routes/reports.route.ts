import { combinedReport } from "@/controllers/reports/combinationreport.controller";
import { customerReport } from "@/controllers/reports/customerreport.controller";
import { getStoreGrowthMetrics } from "@/controllers/reports/customersbgrowth.controller";
import { effectivenessController } from "@/controllers/reports/effectivenessreport.controller";
import { getHighRiskActivityReport, getHighRiskActivityReportPdf } from "@/controllers/reports/highriskcustomer.controller";
import { getLossPreventionValueReport } from "@/controllers/reports/lossprevention.controller";
import { OnboardingReportController } from "@/controllers/reports/onboardingreport.controller";
import { storeReportActivity } from "@/controllers/reports/storereport.controller";
import { getSuspiciousOrdersSummary } from "@/controllers/reports/suspiciousorder.controller";
import { riskDashboardController } from "@/controllers/reports/widenetwork.controller";
import { protectRoute, requireActiveOnboarding } from "@/middlewares/auth.middleware";
import { Router } from "express";

const reportsRouter = Router();

// These are PDFs
reportsRouter.get("/store-activity-report", protectRoute, requireActiveOnboarding, storeReportActivity);
reportsRouter.get("/customer-report", protectRoute, requireActiveOnboarding, customerReport);
reportsRouter.get("/combined-report", protectRoute, requireActiveOnboarding, combinedReport);
reportsRouter.get(
  "/high-risk-csutomer-report",
  protectRoute,
  requireActiveOnboarding,
  getHighRiskActivityReport
);
reportsRouter.get(
  "/high-risk-csutomer-report/pdf",
  protectRoute,
  requireActiveOnboarding,
  getHighRiskActivityReportPdf
);

reportsRouter.get(
  "/customer-db-growth",
  protectRoute,
  requireActiveOnboarding,
  getStoreGrowthMetrics
);


reportsRouter.get(
  "/widenetwork-report",
  protectRoute,
  requireActiveOnboarding,
  riskDashboardController
);


// Superadmin cross-store analytics (bypasses the store-onboarding gate — see
// the superadmin check in requireActiveOnboarding).
reportsRouter.get(
  "/onboarding-report",
  protectRoute,
  requireActiveOnboarding,
  OnboardingReportController
);


reportsRouter.get(
  "/effectiveness-report",
  protectRoute,
  requireActiveOnboarding,
  effectivenessController
);



// These are Tables for report page
reportsRouter.get(
  "/suspicious-order-report",
  protectRoute,
  requireActiveOnboarding,
  getSuspiciousOrdersSummary
);
reportsRouter.get(
  "/loss-prevention-report",
  protectRoute,
  requireActiveOnboarding,
  getLossPreventionValueReport
);

export default reportsRouter;
