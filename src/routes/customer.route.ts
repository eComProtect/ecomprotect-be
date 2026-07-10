import { Router } from "express";
import { protectRoute, requireActiveOnboarding } from "@/middlewares/auth.middleware";
import {
  blockCustomer,
  unblockCustomer,
} from "@/controllers/customer/blockcustomer.controller";
import { TotalFlaggedCustomers } from "@/controllers/customer/totalflagged.controller";
import { getCustomerRefundsAcrossStores } from "@/controllers/customer/getcustomerforstore.controller";
import { getCustomersForAdminDashboard } from "@/controllers/customer/getcustomersforadmin.controller";
import { getRepeatedOffenders } from "@/controllers/customer/getrepeatedoffenders.controller";
import { getTopRiskyIPs } from "@/controllers/customer/getriskyips.controller";
import { getTopFlaggedReasons } from "@/controllers/customer/topflaggedreason.controller";
import { getMonthlyRiskIncidents } from "@/controllers/customer/riskincidents.controller";
import { getRiskChartData } from "@/controllers/customer/getaffectedincidents.controller";
import { getFlaggedCustomersAndStores } from "@/controllers/customer/getflaggedcustomer.controller";

const customerRouter = Router();

customerRouter.get(
  "/customers",
  protectRoute,
  requireActiveOnboarding,
  getCustomerRefundsAcrossStores
);
// Cross-store superadmin dashboard — no single store's onboarding state applies.
customerRouter.get("/admin-customers", getCustomersForAdminDashboard);
customerRouter.post("/block-customer", protectRoute, requireActiveOnboarding, blockCustomer);
customerRouter.post("/unblock-customer", protectRoute, requireActiveOnboarding, unblockCustomer);
customerRouter.get(
  "/total-flagged-customer",
  protectRoute,
  requireActiveOnboarding,
  TotalFlaggedCustomers
);

customerRouter.get(
  "/repeated-offenders",
  protectRoute,
  requireActiveOnboarding,
  getRepeatedOffenders
);
customerRouter.get("/top-risky-ips", protectRoute, requireActiveOnboarding, getTopRiskyIPs);
customerRouter.get(
  "/top-flagged-reason",
  protectRoute,
  requireActiveOnboarding,
  getTopFlaggedReasons
);
customerRouter.get(
  "/monthly-risk-incidents",
  protectRoute,
  requireActiveOnboarding,
  getMonthlyRiskIncidents
);
customerRouter.get(
  "/risk-chart-data",
  protectRoute,
  requireActiveOnboarding,
  getRiskChartData
);
customerRouter.get(
  "/flagged-customer-store",
  protectRoute,
  requireActiveOnboarding,
  getFlaggedCustomersAndStores
);

export default customerRouter;
