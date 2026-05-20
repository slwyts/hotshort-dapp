import type { Env } from "../env";
import { AI_PACKAGE_STOCK_RELEASE_SCHEDULE, BPS_DENOMINATOR } from "@/lib/constants/business-rules";
import { decLockedStock } from "./stocks";
import { nowSeconds } from "./time";
import { ulid } from "./ulid";

const MONTH_SECONDS = 30 * 86400;

export async function createAiStockReleaseSchedule(env: Env, params: {
  orderId: string;
  user: string;
  totalStock: bigint;
  createdAt: number;
}): Promise<void> {
  if (params.totalStock <= 0n) return;

  let allocated = 0n;
  for (let index = 0; index < AI_PACKAGE_STOCK_RELEASE_SCHEDULE.length; index++) {
    const item = AI_PACKAGE_STOCK_RELEASE_SCHEDULE[index];
    const amount = index === AI_PACKAGE_STOCK_RELEASE_SCHEDULE.length - 1
      ? params.totalStock - allocated
      : (params.totalStock * BigInt(item.bps)) / BigInt(BPS_DENOMINATOR);
    allocated += amount;
    if (amount <= 0n) continue;

    await env.DB.prepare(
      `INSERT OR IGNORE INTO ai_stock_releases
        (id, order_id, user, release_index, stock_amount, unlocks_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        ulid(),
        params.orderId,
        params.user.toLowerCase(),
        index + 1,
        amount.toString(),
        params.createdAt + item.month * MONTH_SECONDS,
        params.createdAt,
      )
      .run();
  }
}

export async function releaseDueAiStock(env: Env): Promise<{ releasedRows: number; releasedStock: string }> {
  const now = await nowSeconds(env);
  const rows = await env.DB.prepare(
    `SELECT id, user, stock_amount FROM ai_stock_releases
      WHERE released_at IS NULL AND unlocks_at <= ?
      ORDER BY unlocks_at ASC, release_index ASC`,
  )
    .bind(now)
    .all<{ id: string; user: string; stock_amount: string }>();

  let releasedRows = 0;
  let releasedStock = 0n;
  for (const row of rows.results ?? []) {
    const amount = BigInt(row.stock_amount);
    await decLockedStock(env, row.user, amount);
    await env.DB.prepare("UPDATE ai_stock_releases SET released_at = ? WHERE id = ? AND released_at IS NULL")
      .bind(now, row.id)
      .run();
    releasedRows++;
    releasedStock += amount;
  }

  return { releasedRows, releasedStock: releasedStock.toString() };
}
