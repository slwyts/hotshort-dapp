import type { Env } from "../env";
import { ulid } from "./ulid";
import { addStock, getStockPriceUsdt } from "./stocks";
import { recordThreeGenReferral } from "./referral";
import { todayBeijing } from "./time";
import {
  AI_DIVIDEND_TIER_SHARE_BPS,
  BPS_DENOMINATOR,
  type AiTierKey,
} from "@/lib/constants/business-rules";

interface ConfigSnapshot {
  volumeMin: number;
  volumeMax: number;
  ratioBps: number;
}

async function readConfig(env: Env): Promise<ConfigSnapshot> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM admin_config WHERE key IN ('stock_volume_min_usdt','stock_volume_max_usdt','stock_dividend_ratio_bps')",
  ).all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of rows.results ?? []) map.set(r.key, r.value);
  return {
    volumeMin: Number(map.get("stock_volume_min_usdt") ?? 100_000),
    volumeMax: Number(map.get("stock_volume_max_usdt") ?? 200_000),
    ratioBps: Number(map.get("stock_dividend_ratio_bps") ?? 100),
  };
}

/**
 * §2.2 每日股票分红 cron
 *   1) 当日交易额 = 在 [volumeMin, volumeMax] 区间随机
 *   2) 总池 USDT = 交易额 × ratioBps / 10000
 *   3) 总池股数 = 总池 USDT / 股价
 *   4) 按 §2.2 五档比例（56/25/12/6/1%）切池
 *   5) 每档内：按用户该档累计 USDT 占比再切个人份额
 *   6) §2.4(2) 每个用户份额触发三代返佣（按其购买的最高档作 buyerTier）
 */
export async function settleAiDividend(env: Env): Promise<{ date: string; totalStock: string; recipients: number } | null> {
  const date = await todayBeijing(env);
  const exists = await env.DB.prepare(
    "SELECT settled FROM ai_dividend_pool_daily WHERE date = ?",
  )
    .bind(date)
    .first<{ settled: number }>();
  if (exists?.settled) return null;

  const cfg = await readConfig(env);
  const stockPrice = await getStockPriceUsdt(env);
  if (cfg.volumeMin <= 0 || cfg.volumeMax < cfg.volumeMin) return null;
  const targetVolumeUsdt = cfg.volumeMin + Math.random() * (cfg.volumeMax - cfg.volumeMin);
  const totalPoolUsdt = (targetVolumeUsdt * cfg.ratioBps) / BPS_DENOMINATOR;
  const totalPoolStockNum = totalPoolUsdt / stockPrice;
  const totalPoolStockWei = BigInt(Math.floor(totalPoolStockNum * 1e18));

  await env.DB.prepare(
    `INSERT OR REPLACE INTO ai_dividend_pool_daily (date, target_volume, ratio_bps, total_pool_stock, stock_price_snapshot, settled)
     VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      date,
      String(targetVolumeUsdt),
      cfg.ratioBps,
      totalPoolStockWei.toString(),
      String(stockPrice),
    )
    .run();

  // 拉所有 ai_orders，按用户聚合：每用户 -> {tier: cumulative usdt}
  const orders = await env.DB.prepare(
    "SELECT user, tier, usdt_in FROM ai_orders",
  ).all<{ user: string; tier: AiTierKey; usdt_in: string }>();

  // 按 tier 聚合用户 usdt
  const tierUsers = new Map<AiTierKey, Map<string, bigint>>();
  for (const o of orders.results ?? []) {
    let m = tierUsers.get(o.tier);
    if (!m) {
      m = new Map();
      tierUsers.set(o.tier, m);
    }
    m.set(o.user, (m.get(o.user) ?? 0n) + BigInt(o.usdt_in));
  }

  let recipients = 0;
  for (const [tier, users] of tierUsers) {
    const tierBps = AI_DIVIDEND_TIER_SHARE_BPS[tier] ?? 0;
    if (tierBps === 0 || users.size === 0) continue;
    const tierPoolStockWei = (totalPoolStockWei * BigInt(tierBps)) / BigInt(BPS_DENOMINATOR);

    let totalUsdt = 0n;
    for (const v of users.values()) totalUsdt += v;
    if (totalUsdt === 0n) continue;

    for (const [user, usdt] of users) {
      const share = (tierPoolStockWei * usdt) / totalUsdt;
      if (share <= 0n) continue;

      const existing = await env.DB.prepare(
        "SELECT stock_share FROM ai_dividend_user_daily WHERE date = ? AND user = ?",
      )
        .bind(date, user)
        .first<{ stock_share: string }>();
      const mergedShare = BigInt(existing?.stock_share ?? "0") + share;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO ai_dividend_user_daily (date, user, tier, stock_share, claimed)
         VALUES (?, ?, ?, ?, COALESCE((SELECT claimed FROM ai_dividend_user_daily WHERE date = ? AND user = ?), 0))`,
      )
        .bind(date, user, tier, mergedShare.toString(), date, user)
        .run();

      // 三代返佣（基数为该用户份额的 USDT 等值）
      const shareUsdt = (share * BigInt(Math.floor(stockPrice * 1e18))) / 10n ** 18n;
      await recordThreeGenReferral(env, {
        source: user,
        date,
        stockShareUsdt: shareUsdt,
        buyerTier: tier,
      });
      recipients++;
    }
  }

  await env.DB.prepare("UPDATE ai_dividend_pool_daily SET settled = 1 WHERE date = ?")
    .bind(date)
    .run();

  return { date, totalStock: totalPoolStockWei.toString(), recipients };
}
