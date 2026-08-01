import cloudinary from "@/configs/cloudinary.config";
import { database } from "@/configs/connection.config";
import { users, verification } from "@/schema/schema";
import { decrypt, encrypt } from "@/service/encryption.service";
import { logger } from "@/utils/logger.util";
import { eq } from "drizzle-orm";
import { Request, Response } from "express";
import formidable from "formidable";
import status from "http-status";

/**
 * Returns the currently authenticated user/store. Works for both auth strategies
 * (App Bridge session token for embedded merchants, or the better-auth cookie for the
 * standalone site) because protectRoute populates req.user for either. The encrypted
 * Shopify token is never sent to the client.
 */
export const meController = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(status.UNAUTHORIZED).json({ message: "Not authenticated" });
    return;
  }

  // Omit the encrypted Shopify token from the response.
  const { shopify_access_token: _omit, ...safeUser } =
    req.user as Record<string, unknown>;

  res.status(status.OK).json({
    message: "Current user fetched successfully",
    data: safeUser,
  });
};



export const fetchStoresController = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const allStores = await database.query.users.findMany();

    const stores = allStores.map((store) => ({
      ...store,
      shopify_api_key: store.shopify_api_key
        ? decrypt(store.shopify_api_key)
        : null,
      shopify_access_token: store.shopify_access_token
        ? decrypt(store.shopify_access_token)
        : null,
    }));

    console.log("stores:-", stores);

    res.status(status.OK).json({
      message: "All stores fetched successfully",
      data: stores,
    });
  } catch (error) {
    logger.error("Error in fetchStoresController:", error);
    res.status(status.INTERNAL_SERVER_ERROR).json({
      message: "An error occurred while fetching stores.",
    });
  }
};

export const updateStoreStatusController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userId, isVerified } = req.body;
    const store = await database.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!store) {
      res.status(status.BAD_REQUEST).json({
        message: "Store not found.",
      });
      return;
    }

    await database
      .update(users)
      .set({ emailVerified: isVerified })
      .where(eq(users.id, userId));

    res.status(status.OK).json({
      message: "Store status updated successfully",
    });
  } catch (error) {
    logger.error("Error in updateStoreStatusController:", error);
    res.status(status.INTERNAL_SERVER_ERROR).json({
      message: "An error occurred while updating store status.",
    });
  }
};

export const deleteStoreController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userId } = req.params;

    if (!userId) {
      res.status(status.BAD_REQUEST).json({
        message: "User ID is required.",
      });
      return;
    }

    const store = await database.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!store) {
      res.status(status.NOT_FOUND).json({
        message: "Store not found.",
      });
      return;
    }

    if (store.role === "superadmin") {
      res.status(status.FORBIDDEN).json({
        message: "Superadmin accounts cannot be deleted from store management.",
      });
      return;
    }

    if (req.user?.id === userId) {
      res.status(status.FORBIDDEN).json({
        message: "You cannot delete your own account from store management.",
      });
      return;
    }

    await database.transaction(async (tx) => {
      await tx.delete(verification).where(eq(verification.identifier, store.email));
      await tx.delete(users).where(eq(users.id, userId));
    });

    res.status(status.OK).json({
      message: "Store deleted successfully.",
    });
  } catch (error) {
    logger.error("Error in deleteStoreController:", error);
    res.status(status.INTERNAL_SERVER_ERROR).json({
      message: "An error occurred while deleting the store.",
    });
  }
};

export const imageUpload = async (req: Request, res: Response) => {
  try {
    const form = formidable();

    const [_formData, files] = await form.parse<any, "userProfile">(req);

    const userProfile = files.userProfile?.[0];

    if (!userProfile) {
      res
        .status(status.UNPROCESSABLE_ENTITY)
        .json({ message: "Image not provided" });
      return;
    }

    const cloudinaryResponse = await cloudinary.uploader.upload(
      userProfile.filepath,
      { folder: "user" }
    );
    if (!cloudinaryResponse) {
      res
        .status(status.UNPROCESSABLE_ENTITY)
        .json({ message: "Problem with image" });
      return;
    }

    res.json({ url: cloudinaryResponse.secure_url });
  } catch (err: any) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
    return;
  }
};

export const incrementSearchCount = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(status.UNAUTHORIZED).json({ message: "Store not identified." });
      return;
    }

    const store = await database.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!store) {
      res.status(status.BAD_REQUEST).json({ message: "Store not found." });
      return;
    }

    const currentCount = store.totalSearches || 0;
    await database
      .update(users)
      .set({ totalSearches: currentCount + 1 })
      .where(eq(users.id, userId));

    res.status(status.OK).json({
      message: "Search count incremented successfully",
    });
  } catch (error) {
    logger.error("Error in incrementSearchCount:", error);
    res.status(status.INTERNAL_SERVER_ERROR).json({
      message: "An error occurred while incrementing search count.",
    });
  }
};

export const updateStoreCredentialsController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { userId, shopify_api_key, shopify_access_token } = req.body;

    if (!userId) {
      res.status(status.BAD_REQUEST).json({
        message: "User ID is required.",
      });
      return;
    }

    const store = await database.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!store) {
      res.status(status.BAD_REQUEST).json({
        message: "Store not found.",
      });
      return;
    }

    const updateData: any = {};
    if (shopify_api_key) {
      updateData.shopify_api_key = encrypt(shopify_api_key);
    }
    if (shopify_access_token) {
      updateData.shopify_access_token = encrypt(shopify_access_token);
    }

    if (Object.keys(updateData).length === 0) {
      res.status(status.BAD_REQUEST).json({
        message: "No credentials provided to update.",
      });
      return;
    }

    await database
      .update(users)
      .set(updateData)
      .where(eq(users.id, userId));

    res.status(status.OK).json({
      message: "Store credentials updated successfully",
    });
  } catch (error) {
    logger.error("Error in updateStoreCredentialsController:", error);
    res.status(status.INTERNAL_SERVER_ERROR).json({
      message: "An error occurred while updating store credentials.",
    });
  }
};
