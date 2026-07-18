import { database } from "@/configs/connection.config";
import { settings } from "@/schema/schema";
import status from "http-status";
import { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { resolveStoreRow } from "@/middlewares/auth.middleware";

export const fetchSettings = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(status.UNAUTHORIZED).json({ message: "Not authenticated" });
      return;
    }

    // Settings belong to the store (owner row), not whichever staff member
    // happens to be asking — otherwise a staff session's own id never
    // matches settings.storeId and the page renders empty.
    const store = await resolveStoreRow(req.user);
    const storeId = store?.id;

    if (!storeId) {
      res.status(status.BAD_REQUEST).json({ message: "Store ID is required" });
      return;
    }
    const [existing] = await database
      .select()
      .from(settings)
      .where(eq(settings.storeId, storeId as string));

    // Explicitly null, never undefined: when no settings row exists yet (a
    // brand-new store), `data: undefined` gets silently dropped by
    // JSON.stringify, and the frontend's queryFn resolving to undefined
    // sends TanStack Query into an error/retry loop instead of ever
    // settling — the page stays stuck on its loading state indefinitely.
    res.status(status.OK).json({
      message: "Settings fetched successfully",
      data: existing ?? null,
    });
  } catch (error) {
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Internal server error" });
  }
};
