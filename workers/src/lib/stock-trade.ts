import type { Env } from "../env";

const STOCK_TRADE_PAUSED_KEY = "stock_trade_paused";

export async function isStockTradePaused(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?")
    .bind(STOCK_TRADE_PAUSED_KEY)
    .first<{ value: string }>();
  return row?.value === "1";
}

export async function setStockTradePaused(env: Env, paused: boolean, updatedBy: string): Promise<{ paused: boolean }> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(STOCK_TRADE_PAUSED_KEY, paused ? "1" : "0", updatedBy, Math.floor(Date.now() / 1000))
    .run();
  return { paused };
}
