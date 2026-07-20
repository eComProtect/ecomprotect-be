import { activities } from "@/schema/schema";
import { database } from "@/configs/connection.config";
import { Request, Response } from "express";
import status from "http-status";
import { desc } from "drizzle-orm";

export const getActivities = async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) ?? "10", 10);
    const records = await database
      .select()
      .from(activities)
      .orderBy(desc(activities.createdAt))
      .limit(limit);

    res.status(status.OK).json(records);
  } catch (error: any) {
    console.error("Failed to fetch activities:", error);
    res.status(status.INTERNAL_SERVER_ERROR).json({ error: error.message });
  }
};
