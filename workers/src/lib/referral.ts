import type { Env } from "../env";
import { ulid } from "./ulid";
import { nowSeconds } from "./time";
import {
  AI_REFERRAL_DIRECT_BPS,
  AI_REFERRAL_3GEN_BPS,
  AI_3GEN_DOWNGRADE_BPS,
  BPS_DENOMINATOR,
  type AiTierKey,
} from "@/lib/constants/business-rules";

const TIER_PRIORITY: Record<AiTierKey, number> = {
  pioneer: 0,
  shine: 1,
  eternal: 2,
  glory: 3,
  genesis: 4,
};

interface Path {
  level1: string | null;
  level2: string | null;
  level3: string | null;
}

async function getPath(env: Env, user: string): Promise<Path> {
  const row = await env.DB.prepare(
    "SELECT level1, level2, level3 FROM referral_paths WHERE user = ?",
  )
    .bind(user.toLowerCase())
    .first<Path>();
  return row ?? { level1: null, level2: null, level3: null };
}

async function getUserHighestTier(env: Env, user: string): Promise<AiTierKey | null> {
  const row = await env.DB.prepare(
    "SELECT tier FROM ai_orders WHERE user = ? ORDER BY created_at DESC",
  )
    .bind(user.toLowerCase())
    .all<{ tier: AiTierKey }>();
  if (!row.results || row.results.length === 0) return null;
  let best: AiTierKey | null = null;
  let bestScore = -1;
  for (const r of row.results) {
    const score = TIER_PRIORITY[r.tier] ?? -1;
    if (score > bestScore) {
      bestScore = score;
      best = r.tier;
    }
  }
  return best;
}

/**
 * 套餐购买的直推一次性返佣（USDT 计价；以 HS 发放，由 cron 或领取时折算）。
 * §2.4(1) 直推无等级压制，下级高于上级也全额拿。
 * §2.1 开拓者 (pioneer) 无返佣。
 */
export async function recordDirectReferral(env: Env, params: {
  buyer: string;
  tier: AiTierKey;
  usdtIn: bigint;
  orderId: string;
}): Promise<void> {
  const { buyer, tier, usdtIn, orderId } = params;
  const bps = AI_REFERRAL_DIRECT_BPS[tier] ?? 0;
  if (bps === 0) return;

  const path = await getPath(env, buyer);
  const upper = path.level1;
  if (!upper) return;

  const reward = (usdtIn * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
  if (reward <= 0n) return;
  const now = await nowSeconds(env);

  await env.DB.prepare(
    `INSERT INTO referral_rewards
       (id, user, source_user, kind, reward_token, reward_amount, basis_amount, basis_kind, source_ref, earned_at)
     VALUES (?, ?, ?, 'direct', 'USDT', ?, ?, 'ai-package', ?, ?)`,
  )
    .bind(
      ulid(),
      upper.toLowerCase(),
      buyer.toLowerCase(),
      reward.toString(),
      usdtIn.toString(),
      orderId,
      now,
    )
    .run();
}

/**
 * 每日股票分红的三代返佣。
 * §2.4(3) 仅下级等级高于自身时减半（AI_3GEN_DOWNGRADE_BPS=5000 → 50%）。
 * 基数为下级当日分得的股票（USDT 等值）。
 */
export async function recordThreeGenReferral(env: Env, params: {
  source: string;
  date: string;
  stockShareUsdt: bigint;
  buyerTier: AiTierKey;
}): Promise<void> {
  const path = await getPath(env, params.source);
  const ancestors: (string | null)[] = [path.level1, path.level2, path.level3];
  const sourceScore = TIER_PRIORITY[params.buyerTier];
  const now = await nowSeconds(env);

  for (let i = 0; i < 3; i++) {
    const upper = ancestors[i];
    if (!upper) continue;
    const upperTier = await getUserHighestTier(env, upper);
    if (!upperTier) continue;
    const upperScore = TIER_PRIORITY[upperTier];
    const bpsArr = AI_REFERRAL_3GEN_BPS[upperTier];
    const bps = bpsArr[i] ?? 0;
    if (bps === 0) continue;

    let reward = (params.stockShareUsdt * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
    if (sourceScore > upperScore) {
      reward = (reward * BigInt(AI_3GEN_DOWNGRADE_BPS)) / BigInt(BPS_DENOMINATOR);
    }
    if (reward <= 0n) continue;

    await env.DB.prepare(
      `INSERT INTO referral_rewards
         (id, user, source_user, kind, reward_token, reward_amount, basis_amount, basis_kind, source_ref, earned_at)
       VALUES (?, ?, ?, ?, 'STOCK', ?, ?, 'stock-dividend', ?, ?)`,
    )
      .bind(
        ulid(),
        upper.toLowerCase(),
        params.source.toLowerCase(),
        `gen${i + 1}`,
        reward.toString(),
        params.stockShareUsdt.toString(),
        params.date,
        now,
      )
      .run();
  }
}
