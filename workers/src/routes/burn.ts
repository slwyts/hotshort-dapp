import { Hono } from "hono";
import { type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser, requireBoundUser } from "../lib/users";
import { ulid } from "../lib/ulid";
import { nowSeconds } from "../lib/time";
import { createClaimSignature, getExistingSignature, getExistingSignatureForUserReason } from "../lib/claims";
import { deterministicNonce } from "../lib/nonce";
import { markRewardRowsSigned, type RewardClaimRow } from "../lib/reward-claims";
import { readTokenBalance } from "../lib/token-balance";
import { verifyVaultBurn, verifyVaultClaim } from "../lib/vault-events";
import { hsWeiToUsdtSnapshot } from "../lib/pricing";
import {
  BURN_ALLOCATION_BPS,
  BURN_AIRDROP_MIN_USDT,
  BURN_PROMOTION_ACTIVATE_USDT,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

export const burn = new Hono<{ Bindings: Env }>();

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

async function markPersonalBurnClaimed(env: Env, user: string, amount: bigint, claimedAt: number): Promise<void> {
  const normalizedUser = user.toLowerCase();
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
}

/** GET /burn/me  个人状态 + 当周可领总额 */
burn.get("/me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const status = await ensurePersonalRow(c.env, user);
  const personalClaimed = await hasClaimedPersonalBurn(c.env, user);
  const personalClaimableUsdt = status.totalUsdt > 0n && !status.out && !personalClaimed ? status.totalUsdt * 2n : 0n;
  const promotionActivationUsdt = BigInt(BURN_PROMOTION_ACTIVATE_USDT) * 10n ** 18n;

  const pendingRows = await c.env.DB.prepare(
    "SELECT reward_usdt FROM burn_top10_settlements WHERE user = ? AND claimed = 0",
  )
    .bind(user)
    .all<{ reward_usdt: string }>();
  let burnPendingUsdt = 0n;
  let top10RewardUsdt = 0n;
  for (const row of pendingRows.results ?? []) burnPendingUsdt += BigInt(row.reward_usdt);
  top10RewardUsdt = burnPendingUsdt;

  const rewardRows = await c.env.DB.prepare(
    `SELECT kind, reward_token, reward_amount FROM reward_claims
      WHERE user = ? AND claimed = 0
        AND kind IN ('burn-weight', 'stake-burn-dividend', 'ai-burn-airdrop', 'lp-dividend-weight', 'lp-dividend-top10')`,
  )
    .bind(user)
    .all<{ kind: string; reward_token: string; reward_amount: string }>();
  let weightRewardUsdt = 0n;
  let stakeRewardUsdt = 0n;
  let aiRewardHs = 0n;
  let lpDividendRewardUsdt = 0n;
  let burnPendingHs = 0n;
  for (const row of rewardRows.results ?? []) {
    const amount = BigInt(row.reward_amount);
    if (row.reward_token === "USDT") burnPendingUsdt += amount;
    if (row.reward_token === "HS") burnPendingHs += amount;
    if (row.kind === "burn-weight" && row.reward_token === "USDT") weightRewardUsdt += amount;
    else if (row.kind === "stake-burn-dividend" && row.reward_token === "USDT") stakeRewardUsdt += amount;
    else if (row.kind === "ai-burn-airdrop" && row.reward_token === "HS") aiRewardHs += amount;
    else if ((row.kind === "lp-dividend-weight" || row.kind === "lp-dividend-top10") && row.reward_token === "USDT") lpDividendRewardUsdt += amount;
  }

  const referralRows = await c.env.DB.prepare(
    "SELECT reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0 AND reward_token = 'USDT' AND kind IN ('burn-gen1', 'burn-gen2')",
  )
    .bind(user)
    .all<{ reward_amount: string }>();
  let referralRewardUsdt = 0n;
  for (const row of referralRows.results ?? []) {
    const amount = BigInt(row.reward_amount);
    burnPendingUsdt += amount;
    referralRewardUsdt += amount;
  }

  const airdrop = await c.env.DB.prepare(
    "SELECT hotshort_account, status, submitted_at FROM airdrop_list WHERE user = ? ORDER BY submitted_at DESC LIMIT 1",
  )
    .bind(user)
    .first<{ hotshort_account: string; status: "pending" | "sent" | "rejected"; submitted_at: number }>();

  return c.json({
    totalBurnedHs: status.totalHs.toString(),
    totalBurnedUsdt: status.totalUsdt.toString(),
    personalClaimedUsdt: status.claimedUsdt.toString(),
    personalClaimableUsdt: personalClaimableUsdt.toString(),
    personalClaimed,
    out: !!status.out,
    promotionActive: status.totalUsdt >= promotionActivationUsdt,
    promotionActivationUsdt: promotionActivationUsdt.toString(),
    burnPendingUsdt: burnPendingUsdt.toString(),
    burnPendingHs: burnPendingHs.toString(),
    pendingBreakdown: {
      top10Usdt: top10RewardUsdt.toString(),
      weightUsdt: weightRewardUsdt.toString(),
      promotionUsdt: referralRewardUsdt.toString(),
      stakeUsdt: stakeRewardUsdt.toString(),
      aiHs: aiRewardHs.toString(),
      lpDividendUsdt: lpDividendRewardUsdt.toString(),
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

  // 累计燃烧额；个人燃烧权益领取会单独触发出局。
  const status = await ensurePersonalRow(c.env, user);
  const totalHs = status.totalHs + amount;
  const totalUsdt = status.totalUsdt + snapshot.usdtWei;
  await c.env.DB.prepare(
    "UPDATE burn_personal_status SET total_burned_hs = ?, total_burned_usdt = ?, updated_at = ? WHERE user = ?",
  )
    .bind(totalHs.toString(), totalUsdt.toString(), now, user)
    .run();

  return c.json({ id, totalBurnedHs: totalHs.toString(), totalBurnedUsdt: totalUsdt.toString(), out: !!status.out });
});

/**
 * POST /burn/claim/top10  签名领取燃烧模块可领资产：Top10、权重分红、推广奖励、质押分红。
 */
burn.post("/claim/top10", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const status = await ensurePersonalRow(c.env, user);
  const out = !!status.out;
  const now = await nowSeconds(c.env);
  const reason = 4;

  const existing = await getExistingSignatureForUserReason(c.env, user as Address, reason, now);
  if (existing) return c.json(existing);

  const rows = out
    ? { results: [] as { id: string; reward_usdt: string }[] }
    : await c.env.DB.prepare(
      "SELECT id, reward_usdt FROM burn_top10_settlements WHERE user = ? AND claimed = 0",
    )
      .bind(user)
      .all<{ id: string; reward_usdt: string }>();

  const usdtToken = c.env.USDT_TOKEN.toLowerCase() as Address;
  const totals = new Map<Address, bigint>();
  for (const r of rows.results ?? []) addTokenTotal(totals, usdtToken, BigInt(r.reward_usdt));

  const rewardRows = await c.env.DB.prepare(
    `SELECT id, user, kind, reward_token, reward_amount, round, source_ref
       FROM reward_claims
      WHERE user = ? AND claimed = 0 AND reward_token IN ('HS', 'USDT')
        AND kind IN (${out ? "'burn-weight'" : "'burn-weight', 'stake-burn-dividend', 'ai-burn-airdrop', 'lp-dividend-weight', 'lp-dividend-top10'"})`,
  )
    .bind(user)
    .all<RewardClaimRow>();
  for (const row of rewardRows.results ?? []) {
    const token = rewardTokenAddress(c.env, row.reward_token);
    if (token) addTokenTotal(totals, token, BigInt(row.reward_amount));
  }

  const referralRows = out
    ? { results: [] as { id: string; reward_amount: string }[] }
    : await c.env.DB.prepare(
      "SELECT id, reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0 AND reward_token = 'USDT' AND kind IN ('burn-gen1', 'burn-gen2')",
    )
      .bind(user)
      .all<{ id: string; reward_amount: string }>();
  for (const row of referralRows.results ?? []) addTokenTotal(totals, usdtToken, BigInt(row.reward_amount));

  let total = 0n;
  for (const amount of totals.values()) total += amount;
  if (total <= 0n) return c.json({ amount: "0" });

  const batchIds = [
    ...(rows.results ?? []).map((row) => `top10:${row.id}`),
    ...(rewardRows.results ?? []).map((row) => `reward:${row.id}`),
    ...(referralRows.results ?? []).map((row) => `ref:${row.id}`),
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
  for (const row of rows.results ?? []) {
    await c.env.DB.prepare("UPDATE burn_top10_settlements SET claim_nonce = ? WHERE id = ? AND claimed = 0")
      .bind(nonceStr, row.id)
      .run();
  }
  await markRewardRowsSigned(c.env, rewardRows.results ?? [], nonceStr);
  for (const row of referralRows.results ?? []) {
    await c.env.DB.prepare("UPDATE referral_rewards SET claim_nonce = ? WHERE id = ? AND claimed = 0")
      .bind(nonceStr, row.id)
      .run();
  }

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
  if (status.totalUsdt <= 0n) return c.json({ amount: "0", error: "no burn" }, 400);
  if (status.out || await hasClaimedPersonalBurn(c.env, user)) {
    return c.json({ amount: "0", error: "personal burn already claimed" }, 400);
  }

  const now = await nowSeconds(c.env);
  const pending = await c.env.DB.prepare(
    `SELECT nonce, token, amount, reason, deadline, signature
       FROM claim_signatures
      WHERE user = ? AND reason = 8 AND used_at IS NULL AND deadline > ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user, now)
    .first<{ nonce: string; token: string; amount: string; reason: number; deadline: number; signature: Hex }>();

  const token = c.env.USDT_TOKEN.toLowerCase() as Address;
  const expectedAmount = status.totalUsdt * 2n;
  const amount = pending?.token?.toLowerCase() === token ? BigInt(pending.amount) : expectedAmount;
  const vaultBalance = await readTokenBalance(c.env, token, c.env.VAULT_ADDRESS.toLowerCase() as Address).catch(() => null);
  if (vaultBalance === null) return c.json({ error: "vault balance unavailable" }, 503);
  if (vaultBalance < amount) return c.json({ error: "insufficient vault USDT balance" }, 503);

  if (pending?.token?.toLowerCase() === token && BigInt(pending.amount) === expectedAmount) {
    return c.json({
      token: pending.token,
      recipients: [user as Address],
      amounts: [pending.amount],
      amount: pending.amount,
      nonce: pending.nonce,
      deadline: pending.deadline,
      reason: pending.reason,
      signature: pending.signature,
      personalClaimedUsdt: pending.amount,
      pending: true,
    });
  }

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token,
    payouts: [{ recipient: user as Address, amount }],
    reason: 8,
    now,
  });

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
  await markPersonalBurnClaimed(c.env, user, verified.amount, now);

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
