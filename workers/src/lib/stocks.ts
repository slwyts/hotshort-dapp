import type { Env } from "../env";
import { nowSeconds } from "./time";
import { readHsPriceUsdt } from "./hs-price";

const SCALE = 10n ** 18n;

export interface Holdings {
  total: bigint;
  locked: bigint;
}

export async function getHoldings(env: Env, user: string): Promise<Holdings> {
  const u = user.toLowerCase();
  const row = await env.DB.prepare(
    "SELECT total_stock, locked_stock FROM stock_holdings WHERE user = ?",
  )
    .bind(u)
    .first<{ total_stock: string; locked_stock: string }>();
  if (!row) return { total: 0n, locked: 0n };
  return { total: BigInt(row.total_stock), locked: BigInt(row.locked_stock) };
}

/** 增加用户股票余额（购买赠送 / 分红 / 闪兑） */
export async function addStock(env: Env, user: string, amount: bigint, locked = false): Promise<void> {
  if (amount <= 0n) return;
  const u = user.toLowerCase();
  const now = await nowSeconds(env);
  const { total, locked: lk } = await getHoldings(env, u);
  const newTotal = total + amount;
  const newLocked = locked ? lk + amount : lk;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO stock_holdings (user, total_stock, locked_stock, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(u, newTotal.toString(), newLocked.toString(), now)
    .run();
}

/** 减少用户股票余额（领取分红时不动 holdings；卖出/解锁时才用） */
export async function decLockedStock(env: Env, user: string, amount: bigint): Promise<void> {
  if (amount <= 0n) return;
  const u = user.toLowerCase();
  const now = await nowSeconds(env);
  const { locked } = await getHoldings(env, u);
  const newLocked = locked > amount ? locked - amount : 0n;
  await env.DB.prepare(
    "UPDATE stock_holdings SET locked_stock = ?, updated_at = ? WHERE user = ?",
  )
    .bind(newLocked.toString(), now, u)
    .run();
}

/** 当前股价（USDT），从 admin_config 读 */
export async function getStockPriceUsdt(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT value FROM admin_config WHERE key = 'stock_price_usdt'",
  ).first<{ value: string }>();
  const v = Number(row?.value ?? 1);
  return v > 0 ? v : 1;
}

export async function getHsPriceUsdt(env: Env): Promise<number> {
  return readHsPriceUsdt(env);
}

/** 把 USDT (number) 折算成 18-decimal stock 单位（1 stock = stockPriceUsdt） */
export function usdtToStockWei(usdt: number, stockPriceUsdt: number): bigint {
  if (stockPriceUsdt <= 0) return 0n;
  const stockNum = usdt / stockPriceUsdt;
  return BigInt(Math.floor(stockNum * 1e18));
}

export function bigintWei(num: number): bigint {
  return BigInt(Math.floor(num * 1e18));
}

export const STOCK_SCALE = SCALE;
