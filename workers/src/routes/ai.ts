import { Hono } from "hono";
import { type Address } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser } from "../lib/users";
import {
  addStock,
  getHoldings,
  getStockPriceUsdt,
  getHsPriceUsdt,
  usdtToStockWei,
  bigintWei,
} from "../lib/stocks";
import { recordDirectReferral } from "../lib/referral";
import { signClaim } from "../lib/sign";
import { ulid } from "../lib/ulid";
import { requireSecret } from "../env";
import {
  AI_TIERS,
  AI_SWAP_LOCK_SECONDS,
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
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    tier?: string;
    referrer?: string;
  };
  const tier = body.tier as AiTierKey;
  const t = TIER_MAP.get(tier);
  if (!t) return c.json({ error: "bad tier" }, 400);
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }

  await upsertUser(c.env, user, body.referrer ?? null);

  const usdtInWei = bigintWei(t.usdt);
  // 即时赠送股票：USDT × stockGrantBps / BPS_DENOMINATOR / stockPriceUsdt
  const stockPrice = await getStockPriceUsdt(c.env);
  const stockGrantUsdt = (t.usdt * t.stockGrantBps) / BPS_DENOMINATOR;
  const stockGrantWei = usdtToStockWei(stockGrantUsdt, stockPrice);

  const id = ulid();
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
      Math.floor(Date.now() / 1000),
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

  const hsPrice = await getHsPriceUsdt(c.env);
  const stockPrice = await getStockPriceUsdt(c.env);
  const hsWei = BigInt(body.hsAmountWei);

  // stockOut = hsWei * hsPrice / stockPrice
  // 用 1e18 精度把 number → bigint
  const SCALE = 10n ** 18n;
  const ratioScaled = BigInt(Math.floor((hsPrice / stockPrice) * 1e18));
  const stockOut = (hsWei * ratioScaled) / SCALE;

  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
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
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

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

  let totalStock = 0n;
  for (const d of divs.results ?? []) totalStock += BigInt(d.stock_share);
  for (const r of refs.results ?? []) totalStock += BigInt(r.reward_amount);

  if (totalStock <= 0n) {
    return c.json({ token: null, amount: "0", note: "no claimable" });
  }

  // 把股票直接增加到 holdings；不上链（股票是链下账本），用户无需链上 claim
  await addStock(c.env, user, totalStock);

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare("UPDATE ai_dividend_user_daily SET claimed = 1 WHERE user = ? AND claimed = 0")
    .bind(user)
    .run();
  await c.env.DB.prepare(
    "UPDATE referral_rewards SET claimed = 1 WHERE user = ? AND claimed = 0 AND reward_token = 'STOCK'",
  )
    .bind(user)
    .run();

  return c.json({ token: "STOCK", amount: totalStock.toString(), creditedAt: now, divs: divs.results?.length ?? 0, refs: refs.results?.length ?? 0 });
});

/**
 * POST /ai/airdrop/claim  双重 HS 空投领取（保底年化 5% + 燃烧权重 5%；§2.3）
 *   - 解锁门槛：日持股 ≥ 500，HS 持仓 ≥ 10 USDT 等值
 *   - 链上 claim 因为是 HS 实币
 */
ai.post("/airdrop/claim", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  // 详细计算放到 P2.6 实现 — P2.2 先占位
  return c.json({ note: "implemented in P2.6" });
});
