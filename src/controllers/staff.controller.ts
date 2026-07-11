import { Request, Response } from "express";
import status from "http-status";
import { and, eq } from "drizzle-orm";
import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { resolveStoreRow } from "@/middlewares/auth.middleware";
import { logger } from "@/utils/logger.util";

// Roles a staff manager is allowed to assign. Owner/superadmin are excluded —
// this endpoint must never be usable to promote a teammate to store owner or
// platform admin.
const ASSIGNABLE_ROLES = ["manager", "support", "subadmin", "marketing"];

const SENSITIVE_FIELDS = ["shopify_access_token", "shopify_api_key"] as const;

const omitSensitive = (row: typeof users.$inferSelect) => {
  const clone: Record<string, unknown> = { ...row };
  for (const field of SENSITIVE_FIELDS) delete clone[field];
  return clone;
};

/** GET /api/staff — list every staff member belonging to the requester's store. */
export const listStaffController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const store = await resolveStoreRow(req.user!);
    if (!store) {
      res.status(status.BAD_REQUEST).json({ message: "Store not found." });
      return;
    }

    const staff = await database
      .select()
      .from(users)
      .where(eq(users.storeOwnerId, store.id));

    res.status(status.OK).json({
      message: "Staff fetched successfully",
      data: staff.map(omitSensitive),
    });
  } catch (error: any) {
    logger.error(`[Staff] list error: ${error?.message || error}`);
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Failed to fetch staff." });
  }
};

/** PUT /api/staff/:id — update a staff member's profile/role/access within the requester's store. */
export const updateStaffController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, mobile_number, role, banned } = req.body ?? {};

    const store = await resolveStoreRow(req.user!);
    if (!store) {
      res.status(status.BAD_REQUEST).json({ message: "Store not found." });
      return;
    }

    const [target] = await database
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.storeOwnerId, store.id)));

    if (!target) {
      res
        .status(status.NOT_FOUND)
        .json({ message: "Staff member not found for this store." });
      return;
    }

    if (role !== undefined && !ASSIGNABLE_ROLES.includes(role)) {
      res.status(status.BAD_REQUEST).json({ message: "Invalid role." });
      return;
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (mobile_number !== undefined) updateData.mobile_number = mobile_number;
    if (role !== undefined) updateData.role = role;
    if (banned !== undefined) updateData.banned = Boolean(banned);

    const [updated] = await database
      .update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning();

    logger.info(`[Staff] Updated staff ${id} for store ${store.id}`);

    res.status(status.OK).json({
      message: "Staff member updated successfully",
      data: omitSensitive(updated),
    });
  } catch (error: any) {
    logger.error(`[Staff] update error: ${error?.message || error}`);
    res
      .status(status.INTERNAL_SERVER_ERROR)
      .json({ message: "Failed to update staff member." });
  }
};
