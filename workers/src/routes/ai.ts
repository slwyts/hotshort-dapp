import { Hono } from "hono";
import { type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { requireBoundUser } from "../lib/users";
import {
  addStock,
  getHoldings,
  getSellableHoldings,
  getStockQuote,
  getStockPriceUsdt,
  getHsPriceUsdt,
  sellAvailableStock,
  bigintWei,
} from "../lib/stocks";
import { ulid } from "../lib/ulid";
import { nowSeconds, todayBeijing } from "../lib/time";
import { createClaimSignature, getExistingSignature } from "../lib/claims";
import { deterministicNonce } from "../lib/nonce";
import { addRewardClaim, markRewardRowsClaimed, sumRewardRows, type RewardClaimRow } from "../lib/reward-claims";
import { recordAiPackageOrder } from "../lib/ai-orders";
import { decimalToWei, hsWeiToUsdtWei, stockWeiToUsdtWei, usdtWeiToHsWei } from "../lib/pricing";
import { readTokenBalance } from "../lib/token-balance";
import { verifyVaultDeposit } from "../lib/vault-events";
import {
  AI_TIERS,
  AI_AIRDROP_BASE_APR_BPS,
  AI_AIRDROP_MIN_DAILY_STOCK,
  AI_AIRDROP_MIN_HS_USDT,
  type AiTierKey,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

export const ai = new Hono<{ Bindings: Env }>();

const TIER_MAP = new Map(AI_TIERS.map((t) => [t.key as AiTierKey, t]));
const WEI_SCALE = 10n ** 18n;
const AI_AIRDROP_MIN_HOLD_SECONDS = 30 * 24 * 60 * 60;

function parsePositiveWei(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  return amount > 0n ? amount : null;
}

function quoteStockSale(stockWei: bigint, stockPriceUsdt: number, hsPriceUsdt: number) {
  const stockPriceWei = decimalToWei(stockPriceUsdt);
  const hsPriceWei = decimalToWei(hsPriceUsdt);
  if (stockWei <= 0n || stockPriceWei <= 0n || hsPriceWei <= 0n) {
    return { usdtOut: 0n, hsOut: 0n };
  }
  const usdtOut = (stockWei * stockPriceWei) / WEI_SCALE;
  const hsOut = (usdtOut * WEI_SCALE) / hsPriceWei;
  return { usdtOut, hsOut };
}

function monthlyAirdropPeriod(now: number): { previousMonth: string; currentMonthStart: number } {
  const beijing = new Date(now * 1000 + 8 * 3600 * 1000);
  const year = beijing.getUTCFullYear();
  const monthIndex = beijing.getUTCMonth();
  const currentMonthStart = Math.floor((Date.UTC(year, monthIndex, 1) - 8 * 3600 * 1000) / 1000);
  const previous = new Date(Date.UTC(year, monthIndex - 1, 1));
  const previousMonth = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
  return { previousMonth, currentMonthStart };
}

async function firstStockAcquiredAt(env: Env, user: string): Promise<number | null> {
  const [order, swap, holding] = await Promise.all([
    env.DB.prepare("SELECT MIN(created_at) AS at FROM ai_orders WHERE user = ? AND stock_granted != '0'")
      .bind(user)
      .first<{ at: number | null }>(),
    env.DB.prepare("SELECT MIN(swapped_at) AS at FROM stock_swaps WHERE user = ?")
      .bind(user)
      .first<{ at: number | null }>(),
    env.DB.prepare("SELECT updated_at AS at FROM stock_holdings WHERE user = ? AND total_stock != '0'")
      .bind(user)
      .first<{ at: number | null }>(),
  ]);
  const candidates = [order?.at, swap?.at, holding?.at].filter((value): value is number => Number.isFinite(value ?? NaN) && (value ?? 0) > 0);
  return candidates.length ? Math.min(...candidates) : null;
}

/** GET /ai/holdings  当前用户股票持仓（含锁仓） */
ai.get("/holdings", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const h = await getSellableHoldings(c.env, user);
  return c.json({ totalStock: h.total.toString(), lockedStock: h.locked.toString(), availableStock: h.available.toString() });
});

/** GET /ai/orders  当前用户购买的所有套餐 */
ai.get("/orders", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rs = await c.env.DB.prepare(
    "SELECT id, tier, usdt_in, stock_granted, created_at, source_tx_hash FROM ai_orders WHERE user = ? ORDER BY created_at DESC",
  )
    .bind(user)
    .all<{ id: string; tier: string; usdt_in: string; stock_granted: string; created_at: number; source_tx_hash: string }>();

  const orders = [];
  for (const order of rs.results ?? []) {
    const releases = await c.env.DB.prepare(
      `SELECT release_index, stock_amount, unlocks_at, released_at
         FROM ai_stock_releases WHERE order_id = ? ORDER BY release_index ASC`,
    )
      .bind(order.id)
      .all<{ release_index: number; stock_amount: string; unlocks_at: number; released_at: number | null }>();
    let releasedStock = 0n;
    let lockedStock = 0n;
    let nextUnlocksAt: number | null = null;
    for (const release of releases.results ?? []) {
      const amount = BigInt(release.stock_amount);
      if (release.released_at) releasedStock += amount;
      else {
        lockedStock += amount;
        if (!nextUnlocksAt || release.unlocks_at < nextUnlocksAt) nextUnlocksAt = release.unlocks_at;
      }
    }
    orders.push({
      ...order,
      released_stock: releasedStock.toString(),
      locked_stock: lockedStock.toString(),
      next_unlocks_at: nextUnlocksAt,
      releases: releases.results ?? [],
    });
  }
  return c.json({ orders });
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

  const order = await recordAiPackageOrder(c.env, {
    user,
    tier,
    sourceTxHash: body.sourceTxHash,
    creditReferral: true,
  });

  return c.json({
    id: order.id,
    tier,
    usdtIn: order.usdtIn,
    stockGranted: order.stockGranted,
    stockPriceUsdt: order.stockPriceUsdt,
  });
});

/**
 * POST /ai/swap  HS → 股票闪兑（立即可用）
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

  const duplicate = await c.env.DB.prepare("SELECT id FROM stock_swaps WHERE source_tx_hash = ?")
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
  await c.env.DB.prepare(
    `INSERT INTO stock_swaps
       (id, user, hs_in, stock_out, hs_price_usdt, stock_price_usdt, swapped_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user, hsWei.toString(), stockOut.toString(), String(hsPrice), String(stockPrice), now, body.sourceTxHash)
    .run();

  await addStock(c.env, user, stockOut, false);

  return c.json({ id, stockOut: stockOut.toString(), stockLocked: "0", unlocksAt: null });
});

/** GET /ai/sell/quote  查询可卖 WTO 与按当前行情估算的 HS 到账。 */
ai.get("/sell/quote", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const amountParam = c.req.query("stockAmountWei");
  const stockAmount = amountParam ? parsePositiveWei(amountParam) : 0n;
  if (amountParam && stockAmount === null) return c.json({ error: "bad stockAmountWei" }, 400);

  const [holdings, stockPriceUsdt, hsPriceUsdt] = await Promise.all([
    getSellableHoldings(c.env, user),
    getStockPriceUsdt(c.env),
    getHsPriceUsdt(c.env),
  ]);
  const { usdtOut, hsOut } = quoteStockSale(stockAmount ?? 0n, stockPriceUsdt, hsPriceUsdt);

  return c.json({
    holdings: {
      totalStock: holdings.total.toString(),
      lockedStock: holdings.locked.toString(),
      availableStock: holdings.available.toString(),
    },
    stockAmount: (stockAmount ?? 0n).toString(),
    stockPriceUsdt,
    hsPriceUsdt,
    usdtOut: usdtOut.toString(),
    hsOut: hsOut.toString(),
    enough: (stockAmount ?? 0n) <= holdings.available,
  });
});

/** POST /ai/sell  卖出可用 WTO，按成交时行情签发 HS 领取。 */
ai.post("/sell", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { stockAmountWei?: string };
  const stockAmount = parsePositiveWei(body.stockAmountWei);
  if (stockAmount === null) return c.json({ error: "bad stockAmountWei" }, 400);

  const holdings = await getSellableHoldings(c.env, user);
  if (stockAmount > holdings.available) return c.json({ error: "insufficient available stock" }, 400);

  const [stockPriceUsdt, hsPriceUsdt] = await Promise.all([
    getStockPriceUsdt(c.env),
    getHsPriceUsdt(c.env),
  ]);
  const { usdtOut, hsOut } = quoteStockSale(stockAmount, stockPriceUsdt, hsPriceUsdt);
  if (hsOut <= 0n) return c.json({ error: "quote unavailable" }, 503);

  const remaining = await sellAvailableStock(c.env, user, stockAmount);
  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    payouts: [{ recipient: user as Address, amount: hsOut }],
    reason: 7,
  });

  const id = ulid();
  const now = await nowSeconds(c.env);
  await c.env.DB.prepare(
    `INSERT INTO stock_sales
       (id, user, stock_in, hs_out, stock_price_usdt, hs_price_usdt, sold_at, claim_nonce)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user, stockAmount.toString(), hsOut.toString(), String(stockPriceUsdt), String(hsPriceUsdt), now, claim.nonce)
    .run();

  return c.json({
    id,
    stockIn: stockAmount.toString(),
    usdtOut: usdtOut.toString(),
    hsOut: hsOut.toString(),
    stockPriceUsdt,
    hsPriceUsdt,
    holdings: {
      totalStock: remaining.total.toString(),
      lockedStock: remaining.locked.toString(),
      availableStock: remaining.available.toString(),
    },
    ...claim,
  });
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
  const stock = await getStockQuote(c.env);
  const firstStockAt = await firstStockAcquiredAt(c.env, user);
  const now = await nowSeconds(c.env);
  const { previousMonth, currentMonthStart } = monthlyAirdropPeriod(now);

  const pendingDivs = await c.env.DB.prepare(
    "SELECT stock_share FROM ai_dividend_user_daily WHERE user = ? AND claimed = 0",
  )
    .bind(user)
    .all<{ stock_share: string }>();
  const pendingTeamRewards = await c.env.DB.prepare(
    "SELECT reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0 AND reward_token = 'STOCK' AND kind IN ('gen1', 'gen2', 'gen3')",
  )
    .bind(user)
    .all<{ reward_amount: string }>();
  const pendingOtherStockRewards = await c.env.DB.prepare(
    "SELECT reward_amount FROM reward_claims WHERE user = ? AND claimed = 0 AND reward_token = 'STOCK'",
  )
    .bind(user)
    .all<{ reward_amount: string }>();

  let personalStock = 0n;
  for (const row of pendingDivs.results ?? []) personalStock += BigInt(row.stock_share);
  let teamStock = 0n;
  for (const row of pendingTeamRewards.results ?? []) teamStock += BigInt(row.reward_amount);
  let otherStock = 0n;
  for (const row of pendingOtherStockRewards.results ?? []) otherStock += BigInt(row.reward_amount);

  return c.json({
    today,
    stock,
    holdings: { totalStock: h.total.toString(), lockedStock: h.locked.toString() },
    dividend: div ?? { date: today, stock_share: "0", claimed: 0 },
    claimable: {
      personalStock: personalStock.toString(),
      teamStock: teamStock.toString(),
      otherStock: otherStock.toString(),
      totalStock: (personalStock + teamStock + otherStock).toString(),
    },
    airdrop: {
      claimPeriod: previousMonth,
      currentMonthStart,
      firstStockAt,
      monthlyEligibleAt: firstStockAt ? firstStockAt + AI_AIRDROP_MIN_HOLD_SECONDS : null,
    },
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

  const nonce = deterministicNonce("ai-ref", user);
  const now = await nowSeconds(c.env);

  const existing = await getExistingSignature(c.env, nonce, now);
  if (existing) return c.json({ ...existing, rows: refs.results?.length ?? 0 });

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: c.env.USDT_TOKEN.toLowerCase() as Address,
    payouts: [{ recipient: user as Address, amount: total }],
    reason: 5,
    nonce,
  });

  await c.env.DB.prepare("UPDATE referral_rewards SET claimed = 1, claim_nonce = ? WHERE user = ? AND claimed = 0 AND reward_token = 'USDT'")
    .bind(claim.nonce, user)
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

  const now = await nowSeconds(c.env);
  const firstStockAt = await firstStockAcquiredAt(c.env, user);
  const monthlyEligibleAt = firstStockAt ? firstStockAt + AI_AIRDROP_MIN_HOLD_SECONDS : null;
  if (!monthlyEligibleAt || now < monthlyEligibleAt) {
    return c.json({ error: "stock not held one month", monthlyEligibleAt }, 400);
  }

  const hsBalance = await readTokenBalance(c.env, c.env.HS_TOKEN.toLowerCase() as Address, user as Address);
  const hsValueUsdt = await hsWeiToUsdtWei(c.env, hsBalance);
  const minHsValue = BigInt(AI_AIRDROP_MIN_HS_USDT) * 10n ** 18n;
  if (hsValueUsdt < minHsValue) return c.json({ error: "not enough HS holding" }, 400);

  const { previousMonth, currentMonthStart } = monthlyAirdropPeriod(now);
  const existingBase = await c.env.DB.prepare(
    "SELECT id FROM reward_claims WHERE user = ? AND kind = 'ai-base-airdrop' AND source_ref = ?",
  )
    .bind(user, previousMonth)
    .first<{ id: string }>();

  if (!existingBase) {
    const stockValueUsdt = await stockWeiToUsdtWei(c.env, holdings.total);
    const annualUsdt = (stockValueUsdt * BigInt(AI_AIRDROP_BASE_APR_BPS)) / BigInt(BPS_DENOMINATOR);
    const monthlyUsdt = annualUsdt / 12n;
    const monthlyHs = await usdtWeiToHsWei(c.env, monthlyUsdt);
    await addRewardClaim(c.env, {
      user,
      kind: "ai-base-airdrop",
      token: "HS",
      amount: monthlyHs,
      sourceRef: previousMonth,
    });
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, user, kind, reward_token, reward_amount, round, source_ref
       FROM reward_claims
      WHERE user = ? AND claimed = 0 AND reward_token = 'HS'
        AND (
          (kind = 'ai-base-airdrop' AND source_ref = ?)
          OR (kind = 'ai-burn-airdrop' AND created_at < ?)
        )`,
  )
    .bind(user, previousMonth, currentMonthStart)
    .all<RewardClaimRow>();
  const total = sumRewardRows(rows.results ?? []);
  if (total <= 0n) return c.json({ token: null, amount: "0", note: "no claimable" });

  const nonce = deterministicNonce("ai-airdrop", user);

  const existing = await getExistingSignature(c.env, nonce, now);
  if (existing) return c.json({ ...existing, rows: rows.results?.length ?? 0 });

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    payouts: [{ recipient: user as Address, amount: total }],
    reason: 6,
    nonce,
  });
  await markRewardRowsClaimed(c.env, rows.results ?? [], claim.nonce);
  return c.json({ ...claim, rows: rows.results?.length ?? 0 });
});
