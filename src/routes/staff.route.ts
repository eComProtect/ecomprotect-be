import { Router } from "express";
import {
  listStaffController,
  updateStaffController,
} from "@/controllers/staff.controller";
import { protectRoute, requireStaffManager } from "@/middlewares/auth.middleware";

const staffRouter = Router();

staffRouter.get("/", protectRoute, requireStaffManager, listStaffController);
staffRouter.put("/:id", protectRoute, requireStaffManager, updateStaffController);

export default staffRouter;
