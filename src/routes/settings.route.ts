import { fetchSettings } from "./../controllers/settings/getsettings.controller";
import { Router } from "express";
import { adminOnly, protectRoute, requireActiveOnboarding } from "@/middlewares/auth.middleware";
import { createSettings } from "@/controllers/settings/setting.controller";
import { adminFetchSettings, adminUpdateSettings } from "@/controllers/settings/admin.setting.controller";

const settingsRouter = Router();

settingsRouter.post("/create", protectRoute, requireActiveOnboarding, createSettings);
settingsRouter.get("/fetch", protectRoute, requireActiveOnboarding, fetchSettings);

// Admin specific routes
settingsRouter.get("/admin/fetch", protectRoute, adminOnly, adminFetchSettings);
settingsRouter.post("/admin/update", protectRoute, adminOnly, adminUpdateSettings);

export default settingsRouter;
