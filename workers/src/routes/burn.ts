import { Hono } from "hono";
import { type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser, requireBoundUser } from "../lib/users";
import { ulid } from "../lib/ulid";
import { nowSeconds } from "../lib/time";
import { createClaimSignature } from "../lib/claims";
import { markRewardRowsClaimed, sumRewardRows, type RewardClaimRow } from "../lib/reward-claims";
import { verifyVaultBurn } from "../lib/vault-events";
import { hsWeiToUsdtWei } from "../lib/pricing";
import {
  BURN_ALLOCATION_BPS,
  BURN_AIRDROP_MIN_USDT,
  BURN_PROMOTION_ACTIVATE_USDT,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

export const burn = new Hono<{ Bindings: Env }>();

async function getCurrentBurnRound(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'burn_current_round'").first<{ value: string }>();
  return Number(row?.value ?? 1);
}

async function ensurePersonalRow(env: Env, user: string): Promise<{ total: bigint; claimed: bigint; out: number | null }> {
  const row = await env.DB.prepare(
    "SELECT total_burned_hs, total_personal_claimed_hs, out_at FROM burn_personal_status WHERE user = ?",
  )
    .bind(user)
    .first<{ total_burned_hs: string; total_personal_claimed_hs: string; out_at: number | null }>();
  if (!row) {
    await env.DB.prepare(
      "INSERT INTO burn_personal_status (user, updated_at) VALUES (?, ?)",
    )
      .bind(user, await nowSeconds(env))
      .run();
    return { total: 0n, claimed: 0n, out: null };
  }
  return {
    total: BigInt(row.total_burned_hs),
    claimed: BigInt(row.total_personal_claimed_hs),
    out: row.out_at,
  };
}

async function isBurnAirdropEligible(env: Env, burnedHs: bigint): Promise<boolean> {
  const burnedUsdt = await hsWeiToUsdtWei(env, burnedHs);
  return burnedUsdt >= BigInt(BURN_AIRDROP_MIN_USDT) * 10n ** 18n;
}

async function hasClaimedPersonalBurn(env: Env, user: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM burn_records WHERE user = ? AND claimed_individual = 1 LIMIT 1",
  )
    .bind(user.toLowerCase())
    .first<{ id: string }>();
  return !!row;
}

/** GET /burn/me  个人状态 + 当周可领总额 */
burn.get("/me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const status = await ensurePersonalRow(c.env, user);
  const personalClaimed = await hasClaimedPersonalBurn(c.env, user);
  const personalClaimable = status.total > 0n && !status.out && !personalClaimed ? status.total * 2n : 0n;
  const totalBurnedUsdt = await hsWeiToUsdtWei(c.env, status.total);
  const promotionActivationUsdt = BigInt(BURN_PROMOTION_ACTIVATE_USDT) * 10n ** 18n;

  // 我作为 Top10 的未领奖
  const pendingRows = await c.env.DB.prepare(
    "SELECT reward_hs FROM burn_top10_settlements WHERE user = ? AND claimed = 0",
  )
    .bind(user)
    .all<{ reward_hs: string }>();
  let top10Pending = 0n;
  let top10Reward = 0n;
  for (const row of pendingRows.results ?? []) top10Pending += BigInt(row.reward_hs);
  top10Reward = top10Pending;

  const rewardRows = await c.env.DB.prepare(
    `SELECT kind, reward_amount FROM reward_claims
      WHERE user = ? AND claimed = 0 AND reward_token = 'HS'
        AND kind IN ('burn-weight', 'stake-burn-dividend', 'ai-burn-airdrop')`,
  )
    .bind(user)
    .all<{ kind: string; reward_amount: string }>();
  let weightReward = 0n;
  let stakeReward = 0n;
  let aiReward = 0n;
  for (const row of rewardRows.results ?? []) {
    const amount = BigInt(row.reward_amount);
    top10Pending += amount;
    if (row.kind === "burn-weight") weightReward += amount;
    else if (row.kind === "stake-burn-dividend") stakeReward += amount;
    else if (row.kind === "ai-burn-airdrop") aiReward += amount;
  }

  const referralRows = await c.env.DB.prepare(
    "SELECT reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0 AND reward_token = 'HS' AND kind IN ('burn-gen1', 'burn-gen2')",
  )
    .bind(user)
    .all<{ reward_amount: string }>();
  let referralReward = 0n;
  for (const row of referralRows.results ?? []) {
    const amount = BigInt(row.reward_amount);
    top10Pending += amount;
    referralReward += amount;
  }

  return c.json({
    totalBurnedHs: status.total.toString(),
    totalBurnedUsdt: totalBurnedUsdt.toString(),
    personalClaimedHs: status.claimed.toString(),
    personalClaimableHs: personalClaimable.toString(),
    personalClaimed,
    out: !!status.out,
    promotionActive: totalBurnedUsdt >= promotionActivationUsdt,
    promotionActivationUsdt: promotionActivationUsdt.toString(),
    top10PendingHs: top10Pending.toString(),
    pendingBreakdown: {
      top10Hs: top10Reward.toString(),
      weightHs: weightReward.toString(),
      promotionHs: referralReward.toString(),
      stakeHs: stakeReward.toString(),
      aiHs: aiReward.toString(),
    },
    eligibleAirdrop: totalBurnedUsdt >= BigInt(BURN_AIRDROP_MIN_USDT) * 10n ** 18n,
  });
});

/** GET /burn/round  当前周奖池估算 + 上一轮结算快照 */
burn.get("/round", async (c) => {
  const round = await getCurrentBurnRound(c.env);
  const rs = await c.env.DB.prepare(
    "SELECT hs_amount FROM burn_records WHERE settled_round IS NULL",
  ).all<{ hs_amount: string }>();
  let totalBurn = 0n;
  for (const row of rs.results ?? []) totalBurn += BigInt(row.hs_amount);

  const lastCarryRow = await c.env.DB.prepare("SELECT top10_carryover_hs FROM burn_rounds WHERE round = ?")
    .bind(round - 1)
    .first<{ top10_carryover_hs: string }>();
  const carryover = BigInt(lastCarryRow?.top10_carryover_hs ?? "0");
  const alloc = {
    blackHoleHs: ((totalBurn * BigInt(BURN_ALLOCATION_BPS.blackHole)) / BigInt(BPS_DENOMINATOR)).toString(),
    weightPoolHs: ((totalBurn * BigInt(BURN_ALLOCATION_BPS.weight)) / BigInt(BPS_DENOMINATOR)).toString(),
    promotionPoolHs: ((totalBurn * BigInt(BURN_ALLOCATION_BPS.promotion)) / BigInt(BPS_DENOMINATOR)).toString(),
    stakePoolHs: ((totalBurn * BigInt(BURN_ALLOCATION_BPS.stake)) / BigInt(BPS_DENOMINATOR)).toString(),
    aiPoolHs: ((totalBurn * BigInt(BURN_ALLOCATION_BPS.aiStock)) / BigInt(BPS_DENOMINATOR)).toString(),
    top10PoolHs: (((totalBurn * BigInt(BURN_ALLOCATION_BPS.top10)) / BigInt(BPS_DENOMINATOR)) + carryover).toString(),
    top10CarryoverHs: carryover.toString(),
  };

  const last = await c.env.DB.prepare(
    `SELECT round, closed_at, total_burn_hs, weight_pool_hs, promotion_pool_hs,
            stake_pool_hs, ai_pool_hs, top10_pool_hs, black_hole_hs, top10_carryover_hs
       FROM burn_rounds WHERE settled = 1 ORDER BY round DESC LIMIT 1`,
  ).first();

  return c.json({ round, current: { totalBurnHs: totalBurn.toString(), ...alloc }, lastSettled: last ?? null });
});

/** GET /burn/leaderboard  当周 Top 100（实时） */
burn.get("/leaderboard", async (c) => {
  const round = await getCurrentBurnRound(c.env);
  const rs = await c.env.DB.prepare(
    "SELECT user, hs_amount FROM burn_records WHERE settled_round IS NULL",
  ).all<{ user: string; hs_amount: string }>();
  const totals = new Map<string, bigint>();
  for (const row of rs.results ?? []) totals.set(row.user, (totals.get(row.user) ?? 0n) + BigInt(row.hs_amount));
  const rows = [...totals.entries()]
    .map(([user, burnHs]) => ({ user, burn_hs: burnHs.toString() }))
    .sort((a, b) => (BigInt(a.burn_hs) === BigInt(b.burn_hs) ? a.user.localeCompare(b.user) : BigInt(a.burn_hs) > BigInt(b.burn_hs) ? -1 : 1))
    .slice(0, 100);
  return c.json({ round, rows });
});

/** GET /burn/records  当前用户燃烧流水 */
burn.get("/records", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rs = await c.env.DB.prepare(
    `SELECT id, hs_amount, settled_round, claimed_individual, burned_at, source_tx_hash
       FROM burn_records WHERE user = ? ORDER BY burned_at DESC LIMIT 100`,
  )
    .bind(user)
    .all();
  return c.json({ records: rs.results ?? [] });
});

/**
 * POST /burn/record  用户已链上 burnHS() 后 Worker 入账
 *   - indexer 也会被动写入 burn_records；此接口让前端可主动触发不等 30s
 *   - 入参: { sourceTxHash, hsAmountWei, referrer? }
 */
burn.post("/record", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const bound = await requireBoundUser(c.env, user);
  if (!bound) return c.json({ error: "no upline" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    hsAmountWei?: string;
  };
  if (!body.hsAmountWei || !/^\d+$/.test(body.hsAmountWei)) return c.json({ error: "bad amount" }, 400);
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }

  await upsertUser(c.env, user);

  const id = ulid();
  const amount = BigInt(body.hsAmountWei);
  const now = await nowSeconds(c.env);

  // 防重：同 tx_hash 已写入则跳过
  const exists = await c.env.DB.prepare("SELECT id FROM burn_records WHERE source_tx_hash = ?").bind(body.sourceTxHash).first();
  if (exists) return c.json({ id: exists.id as string, dedup: true });

  // referrer 取 DB 中已绑定的上级（业务约束：用户必须先绑定才能 burn）
  const me = await c.env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
    .bind(user)
    .first<{ referrer: string | null }>();
  const referrer = (me?.referrer ?? null) as Address | null;

  await verifyVaultBurn(c.env, {
    txHash: body.sourceTxHash as Hex,
    user: user as Address,
    amount,
  });

  await c.env.DB.prepare(
    `INSERT INTO burn_records (id, user, hs_amount, referrer, burned_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user, amount.toString(), referrer, now, body.sourceTxHash)
    .run();

  // 累计燃烧额；个人燃烧权益领取会单独触发出局。
  const status = await ensurePersonalRow(c.env, user);
  const total = status.total + amount;
  await c.env.DB.prepare(
    "UPDATE burn_personal_status SET total_burned_hs = ?, updated_at = ? WHERE user = ?",
  )
    .bind(total.toString(), now, user)
    .run();

  return c.json({ id, totalBurnedHs: total.toString(), out: !!status.out });
});

/**
 * POST /burn/claim/top10  签名领取燃烧模块可领 HS：Top10、权重分红、推广奖励、质押分红。
 */
burn.post("/claim/top10", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const status = await ensurePersonalRow(c.env, user);
  const out = !!status.out;

  const rows = out
    ? { results: [] as { id: string; reward_hs: string }[] }
    : await c.env.DB.prepare(
      "SELECT id, reward_hs FROM burn_top10_settlements WHERE user = ? AND claimed = 0",
    )
      .bind(user)
      .all<{ id: string; reward_hs: string }>();

  let total = 0n;
  for (const r of rows.results ?? []) total += BigInt(r.reward_hs);

  const rewardRows = await c.env.DB.prepare(
    `SELECT id, user, kind, reward_token, reward_amount, round, source_ref
       FROM reward_claims
      WHERE user = ? AND claimed = 0 AND reward_token = 'HS'
        AND kind IN (${out ? "'burn-weight'" : "'burn-weight', 'stake-burn-dividend', 'ai-burn-airdrop'"})`,
  )
    .bind(user)
    .all<RewardClaimRow>();
  total += sumRewardRows(rewardRows.results ?? []);

  const referralRows = out
    ? { results: [] as { id: string; reward_amount: string }[] }
    : await c.env.DB.prepare(
      "SELECT id, reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0 AND reward_token = 'HS' AND kind IN ('burn-gen1', 'burn-gen2')",
    )
      .bind(user)
      .all<{ id: string; reward_amount: string }>();
  for (const row of referralRows.results ?? []) total += BigInt(row.reward_amount);

  if (total <= 0n) return c.json({ amount: "0" });

  const hsToken = c.env.HS_TOKEN.toLowerCase() as Address;
  const reason = 4; // BURN_DIVIDEND

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: hsToken,
    payouts: [{ recipient: user as Address, amount: total }],
    reason,
  });

  await c.env.DB.prepare("UPDATE burn_top10_settlements SET claimed = 1 WHERE user = ? AND claimed = 0")
    .bind(user)
    .run();
  await markRewardRowsClaimed(c.env, rewardRows.results ?? [], claim.nonce);
  await c.env.DB.prepare("UPDATE referral_rewards SET claimed = 1 WHERE user = ? AND claimed = 0 AND reward_token = 'HS' AND kind IN ('burn-gen1', 'burn-gen2')")
    .bind(user)
    .run();
  return c.json({
    ...claim,
    top10Rows: rows.results?.length ?? 0,
    rewardRows: rewardRows.results?.length ?? 0,
    referralRows: referralRows.results?.length ?? 0,
  });
});

/**
 * POST /burn/claim/personal  个人燃烧权益：仅可领取一次，按累计燃烧 2 倍出局。
 */
burn.post("/claim/personal", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const status = await ensurePersonalRow(c.env, user);
  if (status.total <= 0n) return c.json({ amount: "0", error: "no burn" }, 400);
  if (status.out || await hasClaimedPersonalBurn(c.env, user)) {
    return c.json({ amount: "0", error: "personal burn already claimed" }, 400);
  }

  const amount = status.total * 2n;
  const now = await nowSeconds(c.env);
  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    payouts: [{ recipient: user as Address, amount }],
    reason: 8,
    now,
  });

  await c.env.DB.prepare(
    "UPDATE burn_records SET claimed_individual = 1 WHERE user = ? AND claimed_individual = 0",
  )
    .bind(user)
    .run();
  await c.env.DB.prepare(
    "UPDATE burn_personal_status SET total_personal_claimed_hs = ?, out_at = COALESCE(out_at, ?), updated_at = ? WHERE user = ?",
  )
    .bind(amount.toString(), now, now, user)
    .run();

  return c.json({ ...claim, personalClaimedHs: amount.toString() });
});

/**
 * POST /burn/airdrop/submit  燃烧 ≥1000U 用户提交 hotshort 账户领空投
 */
burn.post("/airdrop/submit", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { hotshortAccount?: string };
  if (!body.hotshortAccount || body.hotshortAccount.length < 3 || body.hotshortAccount.length > 64) {
    return c.json({ error: "bad hotshortAccount" }, 400);
  }

  const status = await ensurePersonalRow(c.env, user);
  if (!await isBurnAirdropEligible(c.env, status.total)) {
    return c.json({ error: "not eligible (need >= 1000U burn)" }, 400);
  }

  // 只允许一次提交（pending）；否则覆盖
  const existing = await c.env.DB.prepare("SELECT id FROM airdrop_list WHERE user = ?").bind(user).first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare("UPDATE airdrop_list SET hotshort_account = ?, status = 'pending' WHERE id = ?")
      .bind(body.hotshortAccount, existing.id)
      .run();
    return c.json({ id: existing.id, updated: true });
  }
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO airdrop_list (id, user, hotshort_account, burn_total, status, submitted_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, user, body.hotshortAccount, status.total.toString(), await nowSeconds(c.env))
    .run();
  return c.json({ id, created: true });
});
