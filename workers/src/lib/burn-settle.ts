import type { Env } from "../env";
import { ulid } from "./ulid";
import {
  BURN_ALLOCATION_BPS,
  BURN_WEEKLY_PAYOUT_BPS,
  BURN_WEEKLY_CARRYOVER_BPS,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

/**
 * §4.4 燃烧周榜结算（每周日 UTC 16:00 = 北京时间周一 00:00）
 *
 * 流程：
 *   1) 当周（settled_round = current）的 burn_records 总额 → burn_rounds
 *   2) 按 50/20/15/5/5/5 分配
 *   3) 选 Top10 → 60% 当周发，40% 滚下周（top10_carryover_hs）
 *   4) 把 records 标记为已结算
 *   5) 推进 burn_current_round
 */
export async function settleBurnRound(env: Env): Promise<{ round: number; total: string; top10: number }> {
  const cur = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'burn_current_round'").first<{ value: string }>();
  const round = Number(cur?.value ?? 1);

  // 已结算则跳过
  const existing = await env.DB.prepare("SELECT settled FROM burn_rounds WHERE round = ?").bind(round).first<{ settled: number }>();
  if (existing?.settled) return { round, total: "0", top10: 0 };

  // 当周燃烧总额（settled_round 为 NULL 或等于 round 的所有 burn_records）
  const totalRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(CAST(hs_amount AS INTEGER)), 0) AS total FROM burn_records WHERE settled_round IS NULL",
  ).first<{ total: number | string }>();
  const totalBurn = BigInt(String(totalRow?.total ?? 0));

  // 上周 Top10 滚入
  const lastCarryRow = await env.DB.prepare("SELECT top10_carryover_hs FROM burn_rounds WHERE round = ?").bind(round - 1).first<{ top10_carryover_hs: string }>();
  const carryover = BigInt(lastCarryRow?.top10_carryover_hs ?? "0");

  // 资金分配
  const blackHole = (totalBurn * BigInt(BURN_ALLOCATION_BPS.blackHole)) / BigInt(BPS_DENOMINATOR);
  const weight = (totalBurn * BigInt(BURN_ALLOCATION_BPS.weight)) / BigInt(BPS_DENOMINATOR);
  const promotion = (totalBurn * BigInt(BURN_ALLOCATION_BPS.promotion)) / BigInt(BPS_DENOMINATOR);
  const stakePool = (totalBurn * BigInt(BURN_ALLOCATION_BPS.stake)) / BigInt(BPS_DENOMINATOR);
  const aiPool = (totalBurn * BigInt(BURN_ALLOCATION_BPS.aiStock)) / BigInt(BPS_DENOMINATOR);
  const top10Pool = (totalBurn * BigInt(BURN_ALLOCATION_BPS.top10)) / BigInt(BPS_DENOMINATOR) + carryover;

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO burn_rounds (round, opened_at, closed_at, total_burn_hs, weight_pool_hs,
       promotion_pool_hs, stake_pool_hs, ai_pool_hs, top10_pool_hs, black_hole_hs, settled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      round,
      now - 7 * 86400,
      now,
      totalBurn.toString(),
      weight.toString(),
      promotion.toString(),
      stakePool.toString(),
      aiPool.toString(),
      top10Pool.toString(),
      blackHole.toString(),
    )
    .run();

  // Top 10：按当周 burn_records 用户聚合
  const top10Rows = await env.DB.prepare(
    `SELECT user, COALESCE(SUM(CAST(hs_amount AS INTEGER)), 0) AS burn
       FROM burn_records WHERE settled_round IS NULL GROUP BY user ORDER BY burn DESC LIMIT 10`,
  ).all<{ user: string; burn: number | string }>();

  const top10 = top10Rows.results ?? [];
  let totalTop10Burn = 0n;
  for (const r of top10) totalTop10Burn += BigInt(String(r.burn));

  const payoutPool = (top10Pool * BigInt(BURN_WEEKLY_PAYOUT_BPS)) / BigInt(BPS_DENOMINATOR);
  const carryNext = top10Pool - payoutPool;

  for (let i = 0; i < top10.length; i++) {
    const u = top10[i];
    const burn = BigInt(String(u.burn));
    if (burn === 0n || totalTop10Burn === 0n) continue;
    const reward = (payoutPool * burn) / totalTop10Burn;
    await env.DB.prepare(
      `INSERT INTO burn_top10_settlements (id, round, user, rank, burn_hs, reward_hs)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(ulid(), round, u.user, i + 1, burn.toString(), reward.toString())
      .run();
  }

  // 标记 burn_records 已结算
  await env.DB.prepare("UPDATE burn_records SET settled_round = ? WHERE settled_round IS NULL").bind(round).run();
  await env.DB.prepare("UPDATE burn_rounds SET top10_carryover_hs = ?, settled = 1 WHERE round = ?")
    .bind(carryNext.toString(), round)
    .run();
  await env.DB.prepare("UPDATE admin_config SET value = ? WHERE key = 'burn_current_round'").bind(String(round + 1)).run();

  return { round, total: totalBurn.toString(), top10: top10.length };
}
