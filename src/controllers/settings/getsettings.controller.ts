import { database } from "@/configs/connection.config";
import { settings } from "@/schema/schema";
import status from "http-status";
import { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { resolveStoreRow } from "@/middlewares/auth.middleware";
import { planHasFeature } from "@/utils/billing.util";

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

    const entitlements = {
      lossRateThreshold: planHasFeature(store.package, "lossRateThreshold"),
      waiverWorkflow: planHasFeature(store.package, "waiverWorkflow"),
    };

    // Reflect entitlement in the returned values too — a downgrade after a
    // higher-tier field was set shouldn't show a merchant a toggle that
    // looks on but is actually being ignored server-side (see
    // setting.controller.ts / order.webhook.ts, which enforce this for real).
    const data = existing
      ? {
          ...existing,
          lossRateThreshold: entitlements.lossRateThreshold
            ? existing.lossRateThreshold
            : null,
          includeWavierLink: entitlements.waiverWorkflow
            ? existing.includeWavierLink
            : false,
        }
      : null;

    // Explicitly null, never undefined: when no settings row exists yet (a
    // brand-new store), `data: undefined` gets silently dropped by
    // JSON.stringify, and the frontend's queryFn resolving to undefined
    // sends TanStack Query into an error/retry loop instead of ever
    // settling — the page stays stuck on its loading state indefinitely.
    res.status(status.OK).json({
      message: "Settings fetched successfully",
      data,
      entitlements,
    });
  } catch (error) {
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Internal server error" });
  }
};
