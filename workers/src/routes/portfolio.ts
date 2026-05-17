import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser } from "./auth";

export const portfolio = new Hono<{ Bindings: Env }>();

interface PortfolioResp {
  /** USDT 等值各项 */
  stakeUsdt: string;
  aiPackageUsdt: string;
  stockUsdt: string;
  stockLockedUsdt: string;
  pendingUsdt: string;
  totalUsdt: string;

  /** 待领明细（USDT 等值） */
  pending: {
    stakeYield: string;
    lotteryPrize: string;
    aiDividend: string;
    burnTop10: string;
    referral: string;
  };

  /** 价格快照 */
  hsPriceUsdt: number;
  stockPriceUsdt: number;

  /** 原始数额 */
  raw: {
    stakeOrdersWei: string;
    aiOrdersUsdtWei: string;
    stockTotalWei: string;
    stockLockedWei: string;
  };
}

async function readPrices(env: Env): Promise<{ hs: number; stock: number }> {
  const rs = await env.DB.prepare(
    "SELECT key, value FROM admin_config WHERE key IN ('stock_price_usdt', 'hs_price_snapshot')",
  ).all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of rs.results ?? []) map.set(r.key, r.value);
  return {
    hs: Number(map.get("hs_price_snapshot") ?? 0.001),
    stock: Number(map.get("stock_price_usdt") ?? 1),
  };
}

/**
 * GET /portfolio
 * 返回当前用户在 DApp 内的总资产（USDT 等值）。
 *
 * 包含：
 *   - 进行中的质押本金（USDT/HS/LP × hsPrice 折算；LP 暂按持仓计入但不计 USD）
 *   - AI 套餐累计投入（usdt_in）
 *   - 股票总持仓（totalStock × stockPrice，含锁定）
 *   - 待领：stake 到期未领 / 彩票中奖 / AI 分红 / 燃烧周榜 / 团队奖励
 */
portfolio.get("/", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const prices = await readPrices(c.env);

  // 1) 质押进行中（未领取的本金）
  const stakeRow = await c.env.DB.prepare(
    `SELECT asset, COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS sum_amount
     FROM stake_orders WHERE user = ? AND claimed = 0
     GROUP BY asset`,
  )
    .bind(user)
    .all<{ asset: string; sum_amount: number | string }>();

  let stakeUsdtNum = 0;
  for (const r of stakeRow.results ?? []) {
    const amount = Number(BigInt(String(r.sum_amount))) / 1e18;
    if (r.asset === "USDT") stakeUsdtNum += amount;
    else if (r.asset === "HS") stakeUsdtNum += amount * prices.hs;
    // LP 价值复杂（需要拉 PancakePair 储备），暂折半保守按 HS×2 估算或忽略；这里按 0 处理
  }

  // 2) AI 套餐 usdt_in 累计
  const aiRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CAST(usdt_in AS INTEGER)), 0) AS sum_usdt
     FROM ai_orders WHERE user = ?`,
  )
    .bind(user)
    .first<{ sum_usdt: number | string }>();
  const aiUsdtWei = BigInt(String(aiRow?.sum_usdt ?? 0));
  const aiUsdtNum = Number(aiUsdtWei) / 1e18;

  // 3) 股票持仓
  const holdRow = await c.env.DB.prepare(
    "SELECT total_stock, locked_stock FROM stock_holdings WHERE user = ?",
  )
    .bind(user)
    .first<{ total_stock: string; locked_stock: string }>();
  const stockTotalWei = BigInt(holdRow?.total_stock ?? "0");
  const stockLockedWei = BigInt(holdRow?.locked_stock ?? "0");
  const stockTotalNum = Number(stockTotalWei) / 1e18;
  const stockLockedNum = Number(stockLockedWei) / 1e18;
  const stockUsdtNum = stockTotalNum * prices.stock;
  const stockLockedUsdtNum = stockLockedNum * prices.stock;

  // 4) 待领明细
  // 4a) 质押到期未领 — 收益部分（不含本金，本金在 1）
  const stakeMatured = await c.env.DB.prepare(
    `SELECT asset, amount, monthly_rate_bps, lock_months
     FROM stake_orders
     WHERE user = ? AND claimed = 0 AND matures_at <= ?`,
  )
    .bind(user, Math.floor(Date.now() / 1000))
    .all<{ asset: string; amount: string; monthly_rate_bps: number; lock_months: number }>();
  let stakePendingUsdt = 0;
  for (const o of stakeMatured.results ?? []) {
    const principalNum = Number(BigInt(o.amount)) / 1e18;
    const principalUsdt = o.asset === "USDT" ? principalNum : o.asset === "HS" ? principalNum * prices.hs : 0;
    const yieldUsdt = (principalUsdt * o.monthly_rate_bps * o.lock_months) / 10_000;
    stakePendingUsdt += yieldUsdt * 0.95; // 95% 给用户，5% 燃烧
  }

  // 4b) 彩票中奖未领（HS）
  const lotRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CAST(prize_hs AS INTEGER)), 0) AS sum_hs
     FROM lottery_tickets WHERE user = ? AND claimed = 0 AND prize_hs IS NOT NULL`,
  )
    .bind(user)
    .first<{ sum_hs: number | string }>();
  const lotPendingUsdt = (Number(BigInt(String(lotRow?.sum_hs ?? 0))) / 1e18) * prices.hs;

  // 4c) AI 分红 + 团队 STOCK 奖励未领（折算 USDT）
  const divRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CAST(stock_share AS INTEGER)), 0) AS sum_stock
     FROM ai_dividend_user_daily WHERE user = ? AND claimed = 0`,
  )
    .bind(user)
    .first<{ sum_stock: number | string }>();
  const divPendingUsdt = (Number(BigInt(String(divRow?.sum_stock ?? 0))) / 1e18) * prices.stock;

  // 4d) 燃烧周榜未领（HS）
  const burnRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CAST(reward_hs AS INTEGER)), 0) AS sum_hs
     FROM burn_top10_settlements WHERE user = ? AND claimed = 0`,
  )
    .bind(user)
    .first<{ sum_hs: number | string }>();
  const burnPendingUsdt = (Number(BigInt(String(burnRow?.sum_hs ?? 0))) / 1e18) * prices.hs;

  // 4e) 团队奖励未领（USDT / STOCK / HS 三种 token，混合折算）
  const refRow = await c.env.DB.prepare(
    `SELECT reward_token, COALESCE(SUM(CAST(reward_amount AS INTEGER)), 0) AS sum_wei
     FROM referral_rewards WHERE user = ? AND claimed = 0
     GROUP BY reward_token`,
  )
    .bind(user)
    .all<{ reward_token: string; sum_wei: number | string }>();
  let refPendingUsdt = 0;
  for (const r of refRow.results ?? []) {
    const num = Number(BigInt(String(r.sum_wei))) / 1e18;
    if (r.reward_token === "USDT") refPendingUsdt += num;
    else if (r.reward_token === "HS") refPendingUsdt += num * prices.hs;
    else if (r.reward_token === "STOCK") refPendingUsdt += num * prices.stock;
  }

  const pendingUsdt = stakePendingUsdt + lotPendingUsdt + divPendingUsdt + burnPendingUsdt + refPendingUsdt;
  const totalUsdt = stakeUsdtNum + aiUsdtNum + stockUsdtNum + pendingUsdt;

  const resp: PortfolioResp = {
    stakeUsdt: stakeUsdtNum.toFixed(6),
    aiPackageUsdt: aiUsdtNum.toFixed(6),
    stockUsdt: stockUsdtNum.toFixed(6),
    stockLockedUsdt: stockLockedUsdtNum.toFixed(6),
    pendingUsdt: pendingUsdt.toFixed(6),
    totalUsdt: totalUsdt.toFixed(6),
    pending: {
      stakeYield: stakePendingUsdt.toFixed(6),
      lotteryPrize: lotPendingUsdt.toFixed(6),
      aiDividend: divPendingUsdt.toFixed(6),
      burnTop10: burnPendingUsdt.toFixed(6),
      referral: refPendingUsdt.toFixed(6),
    },
    hsPriceUsdt: prices.hs,
    stockPriceUsdt: prices.stock,
    raw: {
      stakeOrdersWei: "0",
      aiOrdersUsdtWei: aiUsdtWei.toString(),
      stockTotalWei: stockTotalWei.toString(),
      stockLockedWei: stockLockedWei.toString(),
    },
  };

  return c.json(resp);
});
