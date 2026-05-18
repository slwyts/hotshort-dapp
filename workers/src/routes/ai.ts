import { Hono } from "hono";
import { type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser, requireBoundUser } from "../lib/users";
import {
  addStock,
  getHoldings,
  getStockPriceUsdt,
  getHsPriceUsdt,
  usdtToStockWei,
  bigintWei,
} from "../lib/stocks";
import { recordDirectReferral } from "../lib/referral";
import { ulid } from "../lib/ulid";
import { nowSeconds, todayBeijing } from "../lib/time";
import { createClaimSignature } from "../lib/claims";
import { addRewardClaim, markRewardRowsClaimed, sumRewardRows, type RewardClaimRow } from "../lib/reward-claims";
import { hsWeiToUsdtWei, stockWeiToUsdtWei, usdtWeiToHsWei } from "../lib/pricing";
import { readTokenBalance } from "../lib/token-balance";
import { verifyVaultDeposit } from "../lib/vault-events";
import {
  AI_TIERS,
  AI_SWAP_LOCK_SECONDS,
  AI_AIRDROP_BASE_APR_BPS,
  AI_AIRDROP_MIN_DAILY_STOCK,
  AI_AIRDROP_MIN_HS_USDT,
  type AiTierKey,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

export const ai = new Hono<{ Bindings: Env }>();

const TIER_MAP = new Map(AI_TIERS.map((t) => [t.key as AiTierKey, t]));

/** GET /ai/holdings  当前用户股票持仓（含锁仓） */
ai.get("/holdings", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const h = await getHoldings(c.env, user);
  return c.json({ totalStock: h.total.toString(), lockedStock: h.locked.toString() });
});

/** GET /ai/orders  当前用户购买的所有套餐 */
ai.get("/orders", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rs = await c.env.DB.prepare(
    "SELECT id, tier, usdt_in, stock_granted, created_at, source_tx_hash FROM ai_orders WHERE user = ? ORDER BY created_at DESC",
  )
    .bind(user)
    .all();
  return c.json({ orders: rs.results ?? [] });
});

/**
 * POST /ai/buy  用户已链上 deposit(purpose=2) 后通知 Worker 入账
 * 入参: { sourceTxHash, tier, referrer? }
 */
ai.post("/buy", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const bound = await requireBoundUser(c.env, user);
  if (!bound) return c.json({ error: "no upline" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    tier?: string;
  };
  const tier = body.tier as AiTierKey;
  const t = TIER_MAP.get(tier);
  if (!t) return c.json({ error: "bad tier" }, 400);
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }

  const duplicate = await c.env.DB.prepare("SELECT id FROM ai_orders WHERE source_tx_hash = ?")
    .bind(body.sourceTxHash)
    .first<{ id: string }>();
  if (duplicate) return c.json({ error: "tx already recorded" }, 409);

  const usdtInWei = bigintWei(t.usdt);
  await verifyVaultDeposit(c.env, {
    txHash: body.sourceTxHash as Hex,
    user: user as Address,
    token: c.env.USDT_TOKEN.toLowerCase() as Address,
    amount: usdtInWei,
    purpose: 2,
  });

  await upsertUser(c.env, user);

  // 即时赠送股票：USDT × stockGrantBps / BPS_DENOMINATOR / stockPriceUsdt
  const stockPrice = await getStockPriceUsdt(c.env);
  const stockGrantUsdt = (t.usdt * t.stockGrantBps) / BPS_DENOMINATOR;
  const stockGrantWei = usdtToStockWei(stockGrantUsdt, stockPrice);

  const id = ulid();
  const now = await nowSeconds(c.env);
  await c.env.DB.prepare(
    `INSERT INTO ai_orders (id, user, tier, usdt_in, stock_granted, created_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user,
      tier,
      usdtInWei.toString(),
      stockGrantWei.toString(),
      now,
      body.sourceTxHash,
    )
    .run();

  if (stockGrantWei > 0n) await addStock(c.env, user, stockGrantWei);

  await recordDirectReferral(c.env, { buyer: user, tier, usdtIn: usdtInWei, orderId: id });

  return c.json({
    id,
    tier,
    usdtIn: usdtInWei.toString(),
    stockGranted: stockGrantWei.toString(),
    stockPriceUsdt: stockPrice,
  });
});

/**
 * POST /ai/swap  HS → 股票闪兑（锁仓 2 年）
 * 入参: { sourceTxHash, hsAmountWei }
 */
ai.post("/swap", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    hsAmountWei?: string;
  };
  if (!body.hsAmountWei || !/^\d+$/.test(body.hsAmountWei)) {
    return c.json({ error: "bad amount" }, 400);
  }
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }

  const duplicate = await c.env.DB.prepare("SELECT id FROM stock_swap_locks WHERE source_tx_hash = ?")
    .bind(body.sourceTxHash)
    .first<{ id: string }>();
  if (duplicate) return c.json({ error: "tx already recorded" }, 409);

  const hsWei = BigInt(body.hsAmountWei);
  await verifyVaultDeposit(c.env, {
    txHash: body.sourceTxHash as Hex,
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    amount: hsWei,
    purpose: 5,
  });

  const hsPrice = await getHsPriceUsdt(c.env);
  const stockPrice = await getStockPriceUsdt(c.env);

  // stockOut = hsWei * hsPrice / stockPrice
  // 用 1e18 精度把 number → bigint
  const SCALE = 10n ** 18n;
  const ratioScaled = BigInt(Math.floor((hsPrice / stockPrice) * 1e18));
  const stockOut = (hsWei * ratioScaled) / SCALE;

  const id = ulid();
  const now = await nowSeconds(c.env);
  const unlocks = now + AI_SWAP_LOCK_SECONDS;
  await c.env.DB.prepare(
    `INSERT INTO stock_swap_locks
       (id, user, hs_in, stock_locked, hs_price_usdt, stock_price_usdt, swapped_at, unlocks_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user, hsWei.toString(), stockOut.toString(), String(hsPrice), String(stockPrice), now, unlocks, body.sourceTxHash)
    .run();

  await addStock(c.env, user, stockOut, true);

  return c.json({ id, stockLocked: stockOut.toString(), unlocksAt: unlocks });
});

/**
 * GET /ai/dividend/today  本人当日股票分红明细 + 双重 HS 空投状态
 */
ai.get("/dividend/today", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const today = await todayBeijing(c.env);
  const div = await c.env.DB.prepare(
    "SELECT date, stock_share, claimed FROM ai_dividend_user_daily WHERE date = ? AND user = ?",
  )
    .bind(today, user)
    .first<{ date: string; stock_share: string; claimed: number }>();
  const h = await getHoldings(c.env, user);
  return c.json({
    today,
    holdings: { totalStock: h.total.toString(), lockedStock: h.locked.toString() },
    dividend: div ?? { date: today, stock_share: "0", claimed: 0 },
  });
});

/**
 * POST /ai/dividend/claim  签名领取所有未领分红 + 三代返佣（仅 STOCK 类型）
 */
ai.post("/dividend/claim", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  // 当前阶段：股票账本是链下；这里只把 ai_dividend_user_daily.claimed=1 + referral_rewards.claimed=1，
  // 实际"提现到钱包"由 P2.6 决定走法（增量 stock_holdings 即可，因为股票本就在链下账本里）。
  const divs = await c.env.DB.prepare(
    "SELECT date, stock_share FROM ai_dividend_user_daily WHERE user = ? AND claimed = 0 ORDER BY date",
  )
    .bind(user)
    .all<{ date: string; stock_share: string }>();

  const refs = await c.env.DB.prepare(
    "SELECT id, reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0 AND reward_token = 'STOCK'",
  )
    .bind(user)
    .all<{ id: string; reward_amount: string }>();

  const burnStockRewards = await c.env.DB.prepare(
    "SELECT id, user, kind, reward_token, reward_amount, round, source_ref FROM reward_claims WHERE user = ? AND claimed = 0 AND reward_token = 'STOCK'",
  )
    .bind(user)
    .all<RewardClaimRow>();

  let totalStock = 0n;
  for (const d of divs.results ?? []) totalStock += BigInt(d.stock_share);
  for (const r of refs.results ?? []) totalStock += BigInt(r.reward_amount);
  for (const r of burnStockRewards.results ?? []) totalStock += BigInt(r.reward_amount);

  if (totalStock <= 0n) {
    return c.json({ token: null, amount: "0", note: "no claimable" });
  }

  // 把股票直接增加到 holdings；不上链（股票是链下账本），用户无需链上 claim
  await addStock(c.env, user, totalStock);

  const now = await nowSeconds(c.env);
  await c.env.DB.prepare("UPDATE ai_dividend_user_daily SET claimed = 1 WHERE user = ? AND claimed = 0")
    .bind(user)
    .run();
  await c.env.DB.prepare(
    "UPDATE referral_rewards SET claimed = 1 WHERE user = ? AND claimed = 0 AND reward_token = 'STOCK'",
  )
    .bind(user)
    .run();
  await markRewardRowsClaimed(c.env, burnStockRewards.results ?? [], "STOCK_LEDGER");

  return c.json({ token: "STOCK", amount: totalStock.toString(), creditedAt: now, divs: divs.results?.length ?? 0, refs: refs.results?.length ?? 0, burnStockRewards: burnStockRewards.results?.length ?? 0 });
});

/** POST /ai/referral/claim  领取 AI 直推 USDT 奖励 */
ai.post("/referral/claim", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const refs = await c.env.DB.prepare(
    "SELECT id, reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0 AND reward_token = 'USDT'",
  )
    .bind(user)
    .all<{ id: string; reward_amount: string }>();
  let total = 0n;
  for (const row of refs.results ?? []) total += BigInt(row.reward_amount);
  if (total <= 0n) return c.json({ amount: "0" });

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: c.env.USDT_TOKEN.toLowerCase() as Address,
    payouts: [{ recipient: user as Address, amount: total }],
    reason: 5,
  });

  await c.env.DB.prepare("UPDATE referral_rewards SET claimed = 1 WHERE user = ? AND claimed = 0 AND reward_token = 'USDT'")
    .bind(user)
    .run();
  return c.json({ ...claim, rows: refs.results?.length ?? 0 });
});

/**
 * POST /ai/airdrop/claim  双重 HS 空投领取（保底年化 5% + 燃烧权重 5%；§2.3）
 *   - 解锁门槛：日持股 ≥ 500，HS 持仓 ≥ 10 USDT 等值
 *   - 链上 claim 因为是 HS 实币
 */
ai.post("/airdrop/claim", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const holdings = await getHoldings(c.env, user);
  const minStock = BigInt(AI_AIRDROP_MIN_DAILY_STOCK) * 10n ** 18n;
  if (holdings.total < minStock) return c.json({ error: "not enough stock" }, 400);

  const hsBalance = await readTokenBalance(c.env, c.env.HS_TOKEN.toLowerCase() as Address, user as Address);
  const hsValueUsdt = await hsWeiToUsdtWei(c.env, hsBalance);
  const minHsValue = BigInt(AI_AIRDROP_MIN_HS_USDT) * 10n ** 18n;
  if (hsValueUsdt < minHsValue) return c.json({ error: "not enough HS holding" }, 400);

  const date = await todayBeijing(c.env);
  const existingBase = await c.env.DB.prepare(
    "SELECT id FROM reward_claims WHERE user = ? AND kind = 'ai-base-airdrop' AND source_ref = ?",
  )
    .bind(user, date)
    .first<{ id: string }>();

  if (!existingBase) {
    const stockValueUsdt = await stockWeiToUsdtWei(c.env, holdings.total);
    const annualUsdt = (stockValueUsdt * BigInt(AI_AIRDROP_BASE_APR_BPS)) / BigInt(BPS_DENOMINATOR);
    const dailyUsdt = annualUsdt / 365n;
    const dailyHs = await usdtWeiToHsWei(c.env, dailyUsdt);
    await addRewardClaim(c.env, {
      user,
      kind: "ai-base-airdrop",
      token: "HS",
      amount: dailyHs,
      sourceRef: date,
    });
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, user, kind, reward_token, reward_amount, round, source_ref
       FROM reward_claims
      WHERE user = ? AND claimed = 0 AND reward_token = 'HS'
        AND kind IN ('ai-base-airdrop', 'ai-burn-airdrop')`,
  )
    .bind(user)
    .all<RewardClaimRow>();
  const total = sumRewardRows(rows.results ?? []);
  if (total <= 0n) return c.json({ token: null, amount: "0", note: "no claimable" });

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    payouts: [{ recipient: user as Address, amount: total }],
    reason: 6,
  });
  await markRewardRowsClaimed(c.env, rows.results ?? [], claim.nonce);
  return c.json({ ...claim, rows: rows.results?.length ?? 0 });
});
