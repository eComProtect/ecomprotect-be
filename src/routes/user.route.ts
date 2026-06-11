import { Router } from "express";
import {
  deleteStoreController,
  fetchStoresController,
  imageUpload,
  incrementSearchCount,
  meController,
  updateStoreStatusController,
  updateStoreCredentialsController,
} from "@/controllers/user.controller";
import { adminOnly, protectRoute } from "@/middlewares/auth.middleware";

const userRouter = Router();

userRouter.get("/me", protectRoute, meController);
userRouter.get("/fetch", fetchStoresController);
userRouter.put("/update", updateStoreStatusController);
userRouter.delete("/:userId", protectRoute, adminOnly, deleteStoreController);
userRouter.put("/update-credentials", protectRoute, adminOnly, updateStoreCredentialsController);
userRouter.put("/increment-searches", protectRoute, incrementSearchCount);

userRouter.post("/upload-avatar", imageUpload);

export default userRouter;
