import type { Env } from "../env";
import { nowSeconds } from "./time";

const STOCK_TRADE_PAUSED_KEY = "stock_trade_paused";
const STOCK_MARKET_MODE_KEY = "stock_market_mode";
const STOCK_MARKET_MANUAL_CLOSED_KEY = "stock_market_manual_closed";

export type StockMarketMode = "auto" | "manual";
export type StockMarketClosedReason = "open" | "weekend" | "manual";

export interface StockMarketStatus {
  mode: StockMarketMode;
  manualClosed: boolean;
  autoClosed: boolean;
  closed: boolean;
  reason: StockMarketClosedReason;
  tradePaused: boolean;
}

function isValidMarketMode(value: string | undefined): value is StockMarketMode {
  return value === "auto" || value === "manual";
}

function isClosedValue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

async function isBeijingWeekend(env: Env): Promise<boolean> {
  const now = await nowSeconds(env);
  const beijingDay = new Date(now * 1000 + 8 * 3600 * 1000).getUTCDay();
  return beijingDay === 0 || beijingDay === 6;
}

export async function getStockMarketStatus(env: Env): Promise<StockMarketStatus> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM admin_config WHERE key IN (?, ?, ?)`,
  )
    .bind(STOCK_MARKET_MODE_KEY, STOCK_MARKET_MANUAL_CLOSED_KEY, STOCK_TRADE_PAUSED_KEY)
    .all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const row of rows.results ?? []) map.set(row.key, row.value);

  const legacyPaused = isClosedValue(map.get(STOCK_TRADE_PAUSED_KEY));
  const configuredMode = map.get(STOCK_MARKET_MODE_KEY);
  const mode: StockMarketMode = isValidMarketMode(configuredMode)
    ? configuredMode
    : legacyPaused
      ? "manual"
      : "auto";
  const manualClosed = map.has(STOCK_MARKET_MANUAL_CLOSED_KEY)
    ? isClosedValue(map.get(STOCK_MARKET_MANUAL_CLOSED_KEY))
    : legacyPaused;
  const autoClosed = await isBeijingWeekend(env);
  const closed = mode === "auto" ? autoClosed : manualClosed;

  return {
    mode,
    manualClosed,
    autoClosed,
    closed,
    reason: closed ? (mode === "auto" ? "weekend" : "manual") : "open",
    tradePaused: closed,
  };
}

export async function isStockTradePaused(env: Env): Promise<boolean> {
  return (await getStockMarketStatus(env)).closed;
}

export async function setStockMarketConfig(
  env: Env,
  updates: { mode?: StockMarketMode; manualClosed?: boolean },
  updatedBy: string,
): Promise<StockMarketStatus> {
  const now = Math.floor(Date.now() / 1000);
  if (updates.mode) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(STOCK_MARKET_MODE_KEY, updates.mode, updatedBy, now)
      .run();
  }
  if (typeof updates.manualClosed === "boolean") {
    const value = updates.manualClosed ? "1" : "0";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(STOCK_MARKET_MANUAL_CLOSED_KEY, value, updatedBy, now),
      env.DB.prepare(
        "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(STOCK_TRADE_PAUSED_KEY, value, updatedBy, now),
    ]);
  }
  return getStockMarketStatus(env);
}

export async function setStockTradePaused(env: Env, paused: boolean, updatedBy: string): Promise<{ paused: boolean }> {
  const status = await setStockMarketConfig(env, { mode: "manual", manualClosed: paused }, updatedBy);
  return { paused: status.closed };
}
