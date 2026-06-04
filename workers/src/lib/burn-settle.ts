import type { Env } from "../env";
import { ulid } from "./ulid";
import { nowSeconds } from "./time";
import { addRewardClaim } from "./reward-claims";
import { hsWeiToUsdtWei, stakeAssetWeiToUsdtWei, stockWeiToUsdtWei, usdtWeiToHsWei, usdtWeiToStockWei } from "./pricing";
import { readTokenBalance } from "./token-balance";
import {
  BURN_ALLOCATION_BPS,
  AI_AIRDROP_BURN_WEIGHT_BPS,
  BURN_WEEKLY_PAYOUT_BPS,
  STAKE_BURN_DIVIDEND_MIN_HS_USDT,
  STAKE_BURN_DIVIDEND_MIN_MONTHS,
  BPS_DENOMINATOR,
  type StakeAsset,
} from "@/lib/constants/business-rules";

async function hasMinHsHolding(env: Env, user: string, minUsdt: bigint): Promise<boolean> {
  const hs = await readTokenBalance(env, env.HS_TOKEN.toLowerCase() as `0x${string}`, user as `0x${string}`).catch(() => 0n);
  return await hsWeiToUsdtWei(env, hs) >= minUsdt;
}

async function outUsers(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT user FROM burn_personal_status WHERE out_at IS NOT NULL")
    .all<{ user: string }>();
  return new Set((rows.results ?? []).map((row) => row.user.toLowerCase()));
}

/**
 * §4.4 燃烧周榜结算（每周日 UTC 16:00 = 北京时间周一 00:00）
 *
 * 流程：
 *   1) 当周（settled_round = current）的 burn_records 总额 → burn_rounds
 *   2) 按 50/20/15/5/5/5 分配
 *   3) 选 Top10 → 60% 当周发，40% 滚下周（top10_carryover_usdt）
 *   4) 把 records 标记为已结算
 *   5) 推进 burn_current_round
 */
export async function settleBurnRound(env: Env): Promise<{ round: number; total: string; top10: number }> {
  const cur = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'burn_current_round'").first<{ value: string }>();
  const round = Number(cur?.value ?? 1);

  // 已结算则跳过
  const existing = await env.DB.prepare("SELECT settled FROM burn_rounds WHERE round = ?").bind(round).first<{ settled: number }>();
  if (existing?.settled) return { round, total: "0", top10: 0 };

  // 当周燃烧总额（settled_round 为 NULL 的所有 burn_records）
  const burnRows = await env.DB.prepare(
    "SELECT id, user, hs_amount, usdt_value, referrer FROM burn_records WHERE settled_round IS NULL",
  ).all<{ id: string; user: string; hs_amount: string; usdt_value: string; referrer: string | null }>();
  let totalBurnHs = 0n;
  let totalBurnUsdt = 0n;
  const userBurns = new Map<string, { burnHs: bigint; burnUsdt: bigint }>();
  for (const row of burnRows.results ?? []) {
    const hsAmount = BigInt(row.hs_amount);
    const usdtValue = BigInt(row.usdt_value);
    totalBurnHs += hsAmount;
    totalBurnUsdt += usdtValue;
    const current = userBurns.get(row.user) ?? { burnHs: 0n, burnUsdt: 0n };
    current.burnHs += hsAmount;
    current.burnUsdt += usdtValue;
    userBurns.set(row.user, current);
  }
  const out = await outUsers(env);

  // 上周 Top10 滚入
  const lastCarryRow = await env.DB.prepare("SELECT top10_carryover_usdt FROM burn_rounds WHERE round = ?").bind(round - 1).first<{ top10_carryover_usdt: string }>();
  const carryover = BigInt(lastCarryRow?.top10_carryover_usdt ?? "0");

  // 资金分配
  const blackHole = (totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.blackHole)) / BigInt(BPS_DENOMINATOR);
  const weight = (totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.weight)) / BigInt(BPS_DENOMINATOR);
  const promotion = (totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.promotion)) / BigInt(BPS_DENOMINATOR);
  const stakePool = (totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.stake)) / BigInt(BPS_DENOMINATOR);
  const aiPool = (totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.aiStock)) / BigInt(BPS_DENOMINATOR);
  const top10Pool = (totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.top10)) / BigInt(BPS_DENOMINATOR) + carryover;

  const now = await nowSeconds(env);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO burn_rounds (round, opened_at, closed_at, total_burn_hs, total_burn_usdt, weight_pool_usdt,
       promotion_pool_usdt, stake_pool_usdt, ai_pool_usdt, top10_pool_usdt, black_hole_usdt, settled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      round,
      now - 7 * 86400,
      now,
      totalBurnHs.toString(),
      totalBurnUsdt.toString(),
      weight.toString(),
      promotion.toString(),
      stakePool.toString(),
      aiPool.toString(),
      top10Pool.toString(),
      blackHole.toString(),
    )
    .run();

  // Top 10：按当周 burn_records 用户聚合
  const top10 = [...userBurns.entries()]
    .filter(([user]) => !out.has(user.toLowerCase()))
    .map(([user, burn]) => ({ user, burnHs: burn.burnHs, burnUsdt: burn.burnUsdt }))
    .sort((a, b) => (a.burnUsdt === b.burnUsdt ? a.user.localeCompare(b.user) : a.burnUsdt > b.burnUsdt ? -1 : 1))
    .slice(0, 10);
  let totalTop10BurnUsdt = 0n;
  for (const r of top10) totalTop10BurnUsdt += r.burnUsdt;

  const payoutPool = (top10Pool * BigInt(BURN_WEEKLY_PAYOUT_BPS)) / BigInt(BPS_DENOMINATOR);
  const carryNext = top10Pool - payoutPool;

  for (let i = 0; i < top10.length; i++) {
    const u = top10[i];
    if (u.burnUsdt === 0n || totalTop10BurnUsdt === 0n) continue;
    const reward = (payoutPool * u.burnUsdt) / totalTop10BurnUsdt;
    await env.DB.prepare(
      `INSERT INTO burn_top10_settlements (id, round, user, rank, burn_hs, burn_usdt, reward_usdt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(ulid(), round, u.user, i + 1, u.burnHs.toString(), u.burnUsdt.toString(), reward.toString())
      .run();
  }

  // 注：20% 权重分红与 15% 推广奖励已改为「每笔燃烧实时发放」（见 burn-realtime.ts），
  // 不再于周结算中分配，避免重复发放。本函数只保留前十抢榜、质押、AI 三类周期结算。

  // 5% 质押分红：6 个月及以上订单，按本金 USDT 价值占比，且钱包 HS 持仓满足 10U。
  const minStakeHsValue = BigInt(STAKE_BURN_DIVIDEND_MIN_HS_USDT) * 10n ** 18n;
  const stakeRows = await env.DB.prepare(
    `SELECT id, user, asset, amount FROM stake_orders
      WHERE claimed = 0 AND lock_months >= ?`,
  )
    .bind(STAKE_BURN_DIVIDEND_MIN_MONTHS)
    .all<{ id: string; user: string; asset: StakeAsset; amount: string }>();
  const eligibleStakes: { id: string; user: string; value: bigint }[] = [];
  let totalStakeValue = 0n;
  for (const row of stakeRows.results ?? []) {
    if (out.has(row.user.toLowerCase())) continue;
    if (!await hasMinHsHolding(env, row.user, minStakeHsValue)) continue;
    const value = await stakeAssetWeiToUsdtWei(env, row.asset, BigInt(row.amount));
    if (value <= 0n) continue;
    eligibleStakes.push({ id: row.id, user: row.user, value });
    totalStakeValue += value;
  }
  for (const row of eligibleStakes) {
    await addRewardClaim(env, {
      user: row.user,
      kind: "stake-burn-dividend",
      token: "USDT",
      amount: totalStakeValue > 0n ? (stakePool * row.value) / totalStakeValue : 0n,
      round,
      sourceRef: `stake-burn:${round}:${row.id}`,
      now,
    });
  }

  // 5% AI 股票分红：按链下股票总持仓占比，把 U 池折成 STOCK 奖励。
  const stockRows = await env.DB.prepare("SELECT user, total_stock FROM stock_holdings").all<{ user: string; total_stock: string }>();
  let totalStock = 0n;
  const eligibleStockRows = (stockRows.results ?? []).filter((row) => !out.has(row.user.toLowerCase()));
  for (const row of eligibleStockRows) totalStock += BigInt(row.total_stock);
  const aiPoolStock = await usdtWeiToStockWei(env, aiPool);
  for (const row of eligibleStockRows) {
    const stock = BigInt(row.total_stock);
    await addRewardClaim(env, {
      user: row.user,
      kind: "ai-stock-burn",
      token: "STOCK",
      amount: totalStock > 0n ? (aiPoolStock * stock) / totalStock : 0n,
      round,
      sourceRef: `ai-stock-burn:${round}`,
      now,
    });

    const stockValueUsdt = await stockWeiToUsdtWei(env, stock);
    const weeklyAirdropUsdt = (stockValueUsdt * BigInt(AI_AIRDROP_BURN_WEIGHT_BPS)) / BigInt(BPS_DENOMINATOR) / 52n;
    await addRewardClaim(env, {
      user: row.user,
      kind: "ai-burn-airdrop",
      token: "HS",
      amount: await usdtWeiToHsWei(env, weeklyAirdropUsdt),
      round,
      sourceRef: `ai-burn-airdrop:${round}`,
      now,
    });
  }

  // 标记 burn_records 已结算
  await env.DB.prepare("UPDATE burn_records SET settled_round = ? WHERE settled_round IS NULL").bind(round).run();
  await env.DB.prepare("UPDATE burn_rounds SET top10_carryover_usdt = ?, settled = 1 WHERE round = ?")
    .bind(carryNext.toString(), round)
    .run();
  await env.DB.prepare("UPDATE admin_config SET value = ? WHERE key = 'burn_current_round'").bind(String(round + 1)).run();

  return { round, total: totalBurnUsdt.toString(), top10: top10.length };
}
