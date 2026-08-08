import { database } from "@/configs/connection.config";
import { users } from "@/schema/schema";
import { eq } from "drizzle-orm";
import { getOrderCapForTier } from "@/utils/billing.util";
import { logger } from "@/utils/logger.util";

export interface OrderQuotaResult {
  /** False once the store has hit its plan's monthly order-analysis cap. */
  allowed: boolean;
  /** Orders analyzed so far this month, including this one if allowed. */
  count: number;
  /** Null means uncapped ("5000+" tier, or no tier set yet). */
  cap: number | null;
}

const currentMonthKey = (): string => new Date().toISOString().slice(0, 7); // "YYYY-MM", UTC

/**
 * Call once per order that reaches the analysis pipeline (order.webhook.ts).
 * Lazily resets the counter when the stored month no longer matches the
 * current one — no cron job needed. Not perfectly race-safe under very high
 * concurrent throughput for one store (read-then-write), which is an
 * acceptable tradeoff here: worst case is a handful of orders over-counted
 * or under-counted right at the boundary, not a billing or security issue.
 */
export async function consumeOrderQuota(
  storeId: string,
  tier: string | null | undefined
): Promise<OrderQuotaResult> {
  const cap = getOrderCapForTier(tier);

  const [store] = await database
    .select({
      ordersAnalyzedCount: users.ordersAnalyzedCount,
      ordersAnalyzedMonth: users.ordersAnalyzedMonth,
    })
    .from(users)
    .where(eq(users.id, storeId));

  const thisMonth = currentMonthKey();
  const isNewMonth = store?.ordersAnalyzedMonth !== thisMonth;
  const currentCount = isNewMonth ? 0 : store?.ordersAnalyzedCount ?? 0;

  if (cap !== null && currentCount >= cap) {
    // Persist the month reset even when denying, so a store that's been
    // over cap all month doesn't redo this reset check on every single order.
    if (isNewMonth) {
      await database
        .update(users)
        .set({ ordersAnalyzedCount: 0, ordersAnalyzedMonth: thisMonth })
        .where(eq(users.id, storeId));
    }
    return { allowed: false, count: currentCount, cap };
  }

  const newCount = currentCount + 1;

  await database
    .update(users)
    .set({ ordersAnalyzedCount: newCount, ordersAnalyzedMonth: thisMonth })
    .where(eq(users.id, storeId));

  if (cap !== null && newCount === cap) {
    logger.warn(`[OrderQuota] Store ${storeId} reached its monthly cap (${cap}, tier ${tier}).`);
  }

  return { allowed: true, count: newCount, cap };
}

/** Read-only peek at current usage — for display, doesn't consume/increment. */
export async function getOrderQuota(
  storeId: string,
  tier: string | null | undefined
): Promise<OrderQuotaResult> {
  const cap = getOrderCapForTier(tier);

  const [store] = await database
    .select({
      ordersAnalyzedCount: users.ordersAnalyzedCount,
      ordersAnalyzedMonth: users.ordersAnalyzedMonth,
    })
    .from(users)
    .where(eq(users.id, storeId));

  const isCurrentMonth = store?.ordersAnalyzedMonth === currentMonthKey();
  const count = isCurrentMonth ? store?.ordersAnalyzedCount ?? 0 : 0;

  return { allowed: cap === null || count < cap, count, cap };
}
