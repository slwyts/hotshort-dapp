import { Hono } from "hono";
import { type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser, requireBoundUser } from "../lib/users";
import { ulid } from "../lib/ulid";
import { nowSeconds } from "../lib/time";
import { createClaimSignature, getExistingSignatureForUserReason } from "../lib/claims";
import { deterministicNonce } from "../lib/nonce";
import { markRewardRowsSigned, type RewardClaimRow } from "../lib/reward-claims";
import { readTokenBalance } from "../lib/token-balance";
import { verifyVaultBurn, verifyVaultClaim } from "../lib/vault-events";
import { hsWeiToUsdtSnapshot } from "../lib/pricing";
import { distributeBurnRealtime, computeWeightClaimable, settleWeightToRewardClaim, enterOutWeightPool } from "../lib/burn-realtime";
import {
  BURN_ALLOCATION_BPS,
  BURN_AIRDROP_MIN_USDT,
  BURN_PROMOTION_ACTIVATE_USDT,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

export const burn = new Hono<{ Bindings: Env }>();

const ACTIVE_BURN_REWARD_KINDS = [
  "stake-burn-dividend",
  "ai-burn-airdrop",
  "lp-dividend-weight",
  "lp-dividend-top10",
] as const;
const OUT_BURN_REWARD_KINDS = ["burn-weight"] as const;

function rewardTokenAddress(env: Env, token: string): Address | null {
  if (token === "HS") return env.HS_TOKEN.toLowerCase() as Address;
  if (token === "USDT") return env.USDT_TOKEN.toLowerCase() as Address;
  return null;
}

function addTokenTotal(map: Map<Address, bigint>, token: Address, amount: bigint): void {
  if (amount <= 0n) return;
  const normalized = token.toLowerCase() as Address;
  map.set(normalized, (map.get(normalized) ?? 0n) + amount);
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function getCurrentBurnRound(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'burn_current_round'").first<{ value: string }>();
  return Number(row?.value ?? 1);
}

async function ensurePersonalRow(env: Env, user: string): Promise<{ totalHs: bigint; totalUsdt: bigint; claimedUsdt: bigint; out: number | null }> {
  const row = await env.DB.prepare(
    "SELECT total_burned_hs, total_burned_usdt, total_personal_claimed_usdt, out_at FROM burn_personal_status WHERE user = ?",
  )
    .bind(user)
    .first<{ total_burned_hs: string; total_burned_usdt: string; total_personal_claimed_usdt: string; out_at: number | null }>();
  if (!row) {
    await env.DB.prepare(
      "INSERT INTO burn_personal_status (user, updated_at) VALUES (?, ?)",
    )
      .bind(user, await nowSeconds(env))
      .run();
    return { totalHs: 0n, totalUsdt: 0n, claimedUsdt: 0n, out: null };
  }
  return {
    totalHs: BigInt(row.total_burned_hs),
    totalUsdt: BigInt(row.total_burned_usdt),
    claimedUsdt: BigInt(row.total_personal_claimed_usdt),
    out: row.out_at,
  };
}

async function hasClaimedPersonalBurn(env: Env, user: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM burn_records WHERE user = ? AND claimed_individual = 1 LIMIT 1",
  )
    .bind(user.toLowerCase())
    .first<{ id: string }>();
  return !!row;
}

async function markPersonalBurnClaimed(env: Env, user: string, amount: bigint, claimedAt: number, nonce?: string): Promise<void> {
  const normalizedUser = user.toLowerCase();
  if (nonce) {
    await env.DB.prepare("UPDATE burn_top10_settlements SET claimed = 1 WHERE user = ? AND claim_nonce = ? AND claimed = 0")
      .bind(normalizedUser, nonce)
      .run();
    await env.DB.prepare("UPDATE reward_claims SET claimed = 1 WHERE user = ? AND claim_nonce = ? AND claimed = 0")
      .bind(normalizedUser, nonce)
      .run();
    await env.DB.prepare("UPDATE referral_rewards SET claimed = 1 WHERE user = ? AND claim_nonce = ? AND claimed = 0")
      .bind(normalizedUser, nonce)
      .run();
  }
  await env.DB.prepare(
    "UPDATE burn_records SET claimed_individual = 1 WHERE user = ? AND claimed_individual = 0",
  )
    .bind(normalizedUser)
    .run();
  await env.DB.prepare(
    "UPDATE burn_personal_status SET total_personal_claimed_usdt = ?, out_at = COALESCE(out_at, ?), updated_at = ? WHERE user = ?",
  )
    .bind(amount.toString(), claimedAt, claimedAt, normalizedUser)
    .run();
  // 出局后把份额并入「出局者权重池」，从此享受 20% 权重分红（含历史 carryover）。
  await enterOutWeightPool(env, normalizedUser);
}

async function collectPendingBurnRewards(env: Env, user: string, out: boolean) {
  const normalizedUser = user.toLowerCase();
  const top10Rows = out
    ? []
    : (await env.DB.prepare(
      "SELECT id, reward_usdt FROM burn_top10_settlements WHERE user = ? AND claimed = 0",
    )
      .bind(normalizedUser)
      .all<{ id: string; reward_usdt: string }>()).results ?? [];

  const rewardKinds = out ? OUT_BURN_REWARD_KINDS : ACTIVE_BURN_REWARD_KINDS;
  const rewardRows = (await env.DB.prepare(
    `SELECT id, user, kind, reward_token, reward_amount, round, source_ref
       FROM reward_claims
      WHERE user = ? AND claimed = 0 AND reward_token IN ('HS', 'USDT')
        AND kind IN (${rewardKinds.map(() => "?").join(",")})`,
  )
    .bind(normalizedUser, ...rewardKinds)
    .all<RewardClaimRow>()).results ?? [];

  let burnPendingUsdt = 0n;
  let burnPendingHs = 0n;
  let top10RewardUsdt = 0n;
  let weightRewardUsdt = 0n;
  let stakeRewardUsdt = 0n;
  let aiRewardHs = 0n;
  let lpDividendRewardUsdt = 0n;

  for (const row of top10Rows) {
    const amount = BigInt(row.reward_usdt);
    burnPendingUsdt += amount;
    top10RewardUsdt += amount;
  }
  for (const row of rewardRows) {
    const amount = BigInt(row.reward_amount);
    if (row.reward_token === "USDT") burnPendingUsdt += amount;
    if (row.reward_token === "HS") burnPendingHs += amount;
    if (row.kind === "burn-weight" && row.reward_token === "USDT") weightRewardUsdt += amount;
    else if (row.kind === "stake-burn-dividend" && row.reward_token === "USDT") stakeRewardUsdt += amount;
    else if (row.kind === "ai-burn-airdrop" && row.reward_token === "HS") aiRewardHs += amount;
    else if ((row.kind === "lp-dividend-weight" || row.kind === "lp-dividend-top10") && row.reward_token === "USDT") lpDividendRewardUsdt += amount;
  }

  return {
    top10Rows,
    rewardRows,
    burnPendingUsdt,
    burnPendingHs,
    top10RewardUsdt,
    weightRewardUsdt,
    stakeRewardUsdt,
    aiRewardHs,
    lpDividendRewardUsdt,
    personalEligibleUsdt: burnPendingUsdt,
  };
}

/** GET /burn/me  个人状态 + 当周可领总额 */
burn.get("/me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const status = await ensurePersonalRow(c.env, user);
  const personalClaimed = await hasClaimedPersonalBurn(c.env, user);
  const personalCapUsdt = status.totalUsdt * 2n;
  const pending = await collectPendingBurnRewards(c.env, user, !!status.out);
  // 权重分红只给出局者；computeWeightClaimable 对未出局用户返回 0。
  const weightLive = await computeWeightClaimable(c.env, user);
  const burnPendingUsdt = pending.burnPendingUsdt + weightLive;
  const weightRewardUsdt = pending.weightRewardUsdt + weightLive;
  const personalEligibleUsdt = pending.personalEligibleUsdt + weightLive;
  const capRemainingUsdt = personalCapUsdt > status.claimedUsdt ? personalCapUsdt - status.claimedUsdt : 0n;
  const personalClaimableUsdt = !status.out && !personalClaimed ? minBigInt(personalEligibleUsdt, capRemainingUsdt) : 0n;
  const promotionActivationUsdt = BigInt(BURN_PROMOTION_ACTIVATE_USDT) * 10n ** 18n;

  const airdrop = await c.env.DB.prepare(
    "SELECT hotshort_account, status, submitted_at FROM airdrop_list WHERE user = ? ORDER BY submitted_at DESC LIMIT 1",
  )
    .bind(user)
    .first<{ hotshort_account: string; status: "pending" | "sent" | "rejected"; submitted_at: number }>();

  return c.json({
    totalBurnedHs: status.totalHs.toString(),
    totalBurnedUsdt: status.totalUsdt.toString(),
    personalCapUsdt: personalCapUsdt.toString(),
    personalClaimedUsdt: status.claimedUsdt.toString(),
    personalClaimableUsdt: personalClaimableUsdt.toString(),
    personalClaimed,
    out: !!status.out,
    promotionActive: status.totalUsdt >= promotionActivationUsdt,
    promotionActivationUsdt: promotionActivationUsdt.toString(),
    burnPendingUsdt: burnPendingUsdt.toString(),
    burnPendingHs: pending.burnPendingHs.toString(),
    pendingBreakdown: {
      top10Usdt: pending.top10RewardUsdt.toString(),
      weightUsdt: weightRewardUsdt.toString(),
      promotionUsdt: "0",
      stakeUsdt: pending.stakeRewardUsdt.toString(),
      aiHs: pending.aiRewardHs.toString(),
      lpDividendUsdt: pending.lpDividendRewardUsdt.toString(),
    },
    eligibleAirdrop: status.totalUsdt >= BigInt(BURN_AIRDROP_MIN_USDT) * 10n ** 18n,
    airdrop: airdrop
      ? {
        hotshortAccount: airdrop.hotshort_account,
        status: airdrop.status,
        submittedAt: airdrop.submitted_at,
      }
      : null,
  });
});

/** GET /burn/round  当前周奖池估算 + 上一轮结算快照 */
burn.get("/round", async (c) => {
  const round = await getCurrentBurnRound(c.env);
  const rs = await c.env.DB.prepare(
    "SELECT hs_amount, usdt_value FROM burn_records WHERE settled_round IS NULL",
  ).all<{ hs_amount: string; usdt_value: string }>();
  let totalBurnHs = 0n;
  let totalBurnUsdt = 0n;
  for (const row of rs.results ?? []) {
    totalBurnHs += BigInt(row.hs_amount);
    totalBurnUsdt += BigInt(row.usdt_value);
  }

  const lastCarryRow = await c.env.DB.prepare("SELECT top10_carryover_usdt FROM burn_rounds WHERE round = ?")
    .bind(round - 1)
    .first<{ top10_carryover_usdt: string }>();
  const carryover = BigInt(lastCarryRow?.top10_carryover_usdt ?? "0");
  const alloc = {
    blackHoleUsdt: ((totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.blackHole)) / BigInt(BPS_DENOMINATOR)).toString(),
    weightPoolUsdt: ((totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.weight)) / BigInt(BPS_DENOMINATOR)).toString(),
    promotionPoolUsdt: ((totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.promotion)) / BigInt(BPS_DENOMINATOR)).toString(),
    stakePoolUsdt: ((totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.stake)) / BigInt(BPS_DENOMINATOR)).toString(),
    aiPoolUsdt: ((totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.aiStock)) / BigInt(BPS_DENOMINATOR)).toString(),
    top10PoolUsdt: (((totalBurnUsdt * BigInt(BURN_ALLOCATION_BPS.top10)) / BigInt(BPS_DENOMINATOR)) + carryover).toString(),
    top10CarryoverUsdt: carryover.toString(),
  };

  const last = await c.env.DB.prepare(
    `SELECT round, closed_at, total_burn_hs, total_burn_usdt, weight_pool_usdt, promotion_pool_usdt,
            stake_pool_usdt, ai_pool_usdt, top10_pool_usdt, black_hole_usdt, top10_carryover_usdt
       FROM burn_rounds WHERE settled = 1 ORDER BY round DESC LIMIT 1`,
  ).first();

  return c.json({ round, current: { totalBurnHs: totalBurnHs.toString(), totalBurnUsdt: totalBurnUsdt.toString(), ...alloc }, lastSettled: last ?? null });
});

/** GET /burn/leaderboard  当周 Top 100（实时） */
burn.get("/leaderboard", async (c) => {
  const round = await getCurrentBurnRound(c.env);
  const rs = await c.env.DB.prepare(
    "SELECT user, hs_amount, usdt_value FROM burn_records WHERE settled_round IS NULL",
  ).all<{ user: string; hs_amount: string; usdt_value: string }>();
  const totals = new Map<string, { burnHs: bigint; burnUsdt: bigint }>();
  for (const row of rs.results ?? []) {
    const current = totals.get(row.user) ?? { burnHs: 0n, burnUsdt: 0n };
    current.burnHs += BigInt(row.hs_amount);
    current.burnUsdt += BigInt(row.usdt_value);
    totals.set(row.user, current);
  }
  const rows = [...totals.entries()]
    .map(([user, burn]) => ({ user, burn_hs: burn.burnHs.toString(), burn_usdt: burn.burnUsdt.toString() }))
    .sort((a, b) => (BigInt(a.burn_usdt) === BigInt(b.burn_usdt) ? a.user.localeCompare(b.user) : BigInt(a.burn_usdt) > BigInt(b.burn_usdt) ? -1 : 1))
    .slice(0, 100);
  return c.json({ round, rows });
});

/** GET /burn/records  当前用户燃烧流水 */
burn.get("/records", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rs = await c.env.DB.prepare(
    `SELECT id, hs_amount, usdt_value, settled_round, claimed_individual, burned_at, source_tx_hash
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
  const rawUser = await requireUser(c);
  if (!rawUser) return c.json({ error: "unauthorized" }, 401);
  const user = rawUser.toLowerCase();
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
  const snapshot = await hsWeiToUsdtSnapshot(c.env, amount);
  if (snapshot.usdtWei <= 0n || snapshot.priceWei <= 0n) return c.json({ error: "HS price unavailable" }, 503);
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
    `INSERT INTO burn_records (id, user, hs_amount, usdt_value, hs_price_usdt_wei, referrer, burned_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user, amount.toString(), snapshot.usdtWei.toString(), snapshot.priceWei.toString(), referrer, now, body.sourceTxHash)
    .run();

  // 实时分配：权重累加器 + 推广直发 + 黑洞记账（累计燃烧额也在此处更新）。
  await ensurePersonalRow(c.env, user);
  await distributeBurnRealtime(c.env);
  const status = await ensurePersonalRow(c.env, user);

  return c.json({ id, totalBurnedHs: status.totalHs.toString(), totalBurnedUsdt: status.totalUsdt.toString(), out: !!status.out });
});

/**
 * POST /burn/claim/top10  签名领取燃烧模块可领资产：Top10、权重分红、质押分红等。
 * 燃烧邀请返佣归团队返佣入口领取，不占用个人燃烧出局额度。
 */
burn.post("/claim/top10", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const status = await ensurePersonalRow(c.env, user);
  const out = !!status.out;
  const personalClaimed = await hasClaimedPersonalBurn(c.env, user);
  if (!out && !personalClaimed) {
    return c.json({ amount: "0", error: "claim personal burn dividends first" }, 400);
  }
  const now = await nowSeconds(c.env);
  const reason = 4;

  const existing = await getExistingSignatureForUserReason(c.env, user as Address, reason, now);
  if (existing) return c.json(existing);

  // 领取前把权重累加器收益结算成一条 burn-weight 待领行，复用既有签名路径。
  await settleWeightToRewardClaim(c.env, user);
  const pending = await collectPendingBurnRewards(c.env, user, out);

  const usdtToken = c.env.USDT_TOKEN.toLowerCase() as Address;
  const totals = new Map<Address, bigint>();
  for (const r of pending.top10Rows) addTokenTotal(totals, usdtToken, BigInt(r.reward_usdt));
  for (const row of pending.rewardRows) {
    const token = rewardTokenAddress(c.env, row.reward_token);
    if (token) addTokenTotal(totals, token, BigInt(row.reward_amount));
  }

  let total = 0n;
  for (const amount of totals.values()) total += amount;
  if (total <= 0n) return c.json({ amount: "0" });

  const batchIds = [
    ...pending.top10Rows.map((row) => `top10:${row.id}`),
    ...pending.rewardRows.map((row) => `reward:${row.id}`),
  ].sort();
  const nonce = deterministicNonce("burn-top10", `${user}:${batchIds.join("|")}`);

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    payouts: [...totals.entries()].map(([token, amount]) => ({ token, recipient: user as Address, amount })),
    reason,
    now,
    nonce,
  });

  const nonceStr = claim.nonce;
  for (const row of pending.top10Rows) {
    await c.env.DB.prepare("UPDATE burn_top10_settlements SET claim_nonce = ? WHERE id = ? AND claimed = 0")
      .bind(nonceStr, row.id)
      .run();
  }
  await markRewardRowsSigned(c.env, pending.rewardRows, nonceStr);

  return c.json({
    ...claim,
    top10Rows: pending.top10Rows.length,
    rewardRows: pending.rewardRows.length,
    referralRows: 0,
  });
});

/**
 * POST /burn/claim/personal  个人燃烧权益：领取当前已结算分红后出局，双倍仅作封顶。
 */
burn.post("/claim/personal", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const status = await ensurePersonalRow(c.env, user);
  if (status.totalUsdt <= 0n) return c.json({ amount: "0", error: "no burn" }, 400);
  if (status.out || await hasClaimedPersonalBurn(c.env, user)) {
    return c.json({ amount: "0", error: "personal burn already claimed" }, 400);
  }

  const personalCapUsdt = status.totalUsdt * 2n;
  const capRemainingUsdt = personalCapUsdt > status.claimedUsdt ? personalCapUsdt - status.claimedUsdt : 0n;
  // 领取前结算权重累加器收益，确保个人领取一并打包。
  await settleWeightToRewardClaim(c.env, user);
  const pending = await collectPendingBurnRewards(c.env, user, false);
  const amount = minBigInt(pending.personalEligibleUsdt, capRemainingUsdt);
  if (amount <= 0n) return c.json({ amount: "0", error: "no claimable burn dividends" }, 400);

  const usdtToken = c.env.USDT_TOKEN.toLowerCase() as Address;
  const vaultBalance = await readTokenBalance(c.env, usdtToken, c.env.VAULT_ADDRESS.toLowerCase() as Address).catch(() => null);
  if (vaultBalance === null) return c.json({ error: "vault balance unavailable" }, 503);
  if (vaultBalance < amount) return c.json({ error: "insufficient vault USDT balance" }, 503);

  const now = await nowSeconds(c.env);
  const nonce = deterministicNonce("burn-personal", user);
  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: usdtToken,
    payouts: [{ recipient: user as Address, amount }],
    reason: 8,
    now,
    nonce,
  });

  for (const row of pending.top10Rows) {
    await c.env.DB.prepare("UPDATE burn_top10_settlements SET claim_nonce = ? WHERE id = ? AND claimed = 0")
      .bind(claim.nonce, row.id)
      .run();
  }
  await markRewardRowsSigned(c.env, pending.rewardRows.filter((row) => row.reward_token === "USDT"), claim.nonce);

  return c.json({ ...claim, personalClaimedUsdt: amount.toString() });
});

/**
 * POST /burn/claim/personal/confirm  前端交易成功后即时回调，cron 索引器只做兜底。
 */
burn.post("/claim/personal/confirm", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { txHash?: string; nonce?: string };
  if (!body.txHash || !/^0x[a-fA-F0-9]{64}$/.test(body.txHash)) return c.json({ error: "bad tx hash" }, 400);
  const expectedNonce = body.nonce && /^\d+$/.test(body.nonce) ? BigInt(body.nonce) : undefined;

  const verified = await verifyVaultClaim(c.env, {
    txHash: body.txHash as Hex,
    user: user as Address,
    token: c.env.USDT_TOKEN.toLowerCase() as Address,
    reason: 8,
    nonce: expectedNonce,
  });

  const now = await nowSeconds(c.env);
  await c.env.DB.prepare(
    "UPDATE claim_signatures SET used_at = ? WHERE nonce = ? AND user = ? AND reason = 8 AND used_at IS NULL",
  )
    .bind(now, verified.nonce.toString(), user)
    .run();
  await markPersonalBurnClaimed(c.env, user, verified.amount, now, verified.nonce.toString());

  return c.json({ confirmed: true, amount: verified.amount.toString(), nonce: verified.nonce.toString() });
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
  if (status.totalUsdt < BigInt(BURN_AIRDROP_MIN_USDT) * 10n ** 18n) {
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
    .bind(id, user, body.hotshortAccount, status.totalUsdt.toString(), await nowSeconds(c.env))
    .run();
  return c.json({ id, created: true });
});
