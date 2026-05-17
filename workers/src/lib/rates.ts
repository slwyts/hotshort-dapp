import type { Env } from "../env";
import { STAKE_DEFAULT_RATES_BPS, type StakeAsset, type StakeLockMonths } from "@/lib/constants/business-rules";

const CACHE = new Map<string, { rate: number; ts: number }>();
const TTL_MS = 30_000;

const KEY = (asset: StakeAsset, months: StakeLockMonths) => `${asset}:${months}`;

/**
 * 取当前 stake_rates 表中某资产/锁仓的月化 bps；表为空时退回 README 默认值。
 * 30s 内缓存，避免每个订单都查 DB。
 */
export async function getCurrentRateBps(
  env: Env,
  asset: StakeAsset,
  months: StakeLockMonths,
): Promise<number> {
  const k = KEY(asset, months);
  const c = CACHE.get(k);
  if (c && Date.now() - c.ts < TTL_MS) return c.rate;

  const row = await env.DB.prepare(
    "SELECT monthly_rate_bps FROM stake_rates WHERE asset = ? AND lock_months = ?",
  )
    .bind(asset, months)
    .first<{ monthly_rate_bps: number }>();

  const rate = row?.monthly_rate_bps ?? STAKE_DEFAULT_RATES_BPS[asset][months];
  CACHE.set(k, { rate, ts: Date.now() });
  return rate;
}

/** 后台改利率时调用，清除该 key 缓存 */
export function invalidateRate(asset: StakeAsset, months: StakeLockMonths) {
  CACHE.delete(KEY(asset, months));
}

export function rateCacheClear() {
  CACHE.clear();
}
