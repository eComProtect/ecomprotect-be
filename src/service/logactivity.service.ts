import { database } from "@/configs/connection.config";
import { activities } from "@/schema/schema";
import { createId } from "@paralleldrive/cuid2";

interface LogActivityParams {
  action: string;
  for: "store" | "customer"
  storeId?: string | null;
  customerId?: string;
  orderId?: string;
  meta?: Record<string, any>;
}

type TransactionClient = Parameters<
  Parameters<typeof database.transaction>[0]
>[0];

// Accepts either the top-level `database` (default) or a `tx` handle from
// database.transaction(), so callers that need the activity row written
// atomically alongside another write (e.g. an upsert its FK depends on) can
// pass their transaction through instead of writing outside of it.
export async function logActivity(
  params: LogActivityParams,
  dbClient: typeof database | TransactionClient = database
) {
  try {
    await dbClient.insert(activities).values({
      id: createId(),
      action: params.action,
      for: params.for,
      storeId: params.storeId ?? null,
      customerId: params.customerId ?? null,
      orderId: params.orderId ?? null,
      meta: params.meta ?? {},
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("logActivity error:", err);
  }
}
