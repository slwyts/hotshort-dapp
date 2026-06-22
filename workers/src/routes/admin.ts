import type { Context } from "hono";
import { Hono } from "hono";
import type { Address } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { invalidateRate } from "../lib/rates";
import { scanGenesisTransfers } from "../lib/genesis-scan";
import { getStockQuote, setManualStockPrice, setStockQuoteMode, syncStockQuote, type StockQuoteMode } from "../lib/stocks";
import { getStockMarketStatus, setStockMarketConfig, type StockMarketMode, type StockMarketStatus } from "../lib/stock-trade";
import { readVaultOwner } from "../lib/vault-owner";
import { ensureAgentTables, listAgentAlerts, listAgentUsers, normalizeAddress } from "../lib/agent-data";
import { directReferralConfigKey } from "../lib/referral";
import { importGenesisNode, normalizeAiTier } from "../lib/genesis-nodes";
import { rebuildReferralPath } from "../lib/users";
import { getTimeDebugInfo, realNowSeconds, setTimeOffset, todayBeijing, nowSeconds } from "../lib/time";
import { distributeLpDividend } from "../lib/lp-dividend";
import { stakeAssetWeiToUsdtWei, tokenForStakeAsset, usdtWeiToHsWei } from "../lib/pricing";
import {
  AI_REFERRAL_DIRECT_BPS,
  AI_TIERS,
  BPS_DENOMINATOR,
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  type AiTierKey,
  type StakeAsset,
  type StakeLockMonths,
} from "@/lib/constants/business-rules";

export const admin = new Hono<{ Bindings: Env }>();

async function requireOwner(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const user = await requireUser(c);
  if (!user) return null;
  try {
    const onchainOwner = await readVaultOwner(c.env);
    return user === onchainOwner ? user : null;
  } catch {
    return null;
  }
}

function withStockMarketStatus<T extends object>(quote: T, market: StockMarketStatus) {
  return {
    ...quote,
    tradePaused: market.closed,
    marketClosed: market.closed,
    marketMode: market.mode,
    manualClosed: market.manualClosed,
    autoClosed: market.autoClosed,
    marketClosedReason: market.reason,
    market,
  };
}

function addPressure(map: Map<Address, bigint>, token: Address, amount: bigint): void {
  if (amount <= 0n) return;
  const normalized = token.toLowerCase() as Address;
  map.set(normalized, (map.get(normalized) ?? 0n) + amount);
}

function rewardTokenAddress(env: Env, token: string): Address | null {
  if (token === "HS") return env.HS_TOKEN.toLowerCase() as Address;
  if (token === "USDT") return env.USDT_TOKEN.toLowerCase() as Address;
  if (token === "LP") return env.PANCAKE_PAIR.toLowerCase() as Address;
  return null;
}

function addSignaturePressure(
  map: Map<Address, bigint>,
  row: { token: string; amount: string; recipients_json: string | null },
): void {
  if (row.recipients_json) {
    try {
      const parsed = JSON.parse(row.recipients_json) as { tokens?: string[]; amounts?: string[] };
      if (parsed.tokens?.length && parsed.amounts?.length && parsed.tokens.length === parsed.amounts.length) {
        for (let i = 0; i < parsed.tokens.length; i++) {
          addPressure(map, parsed.tokens[i].toLowerCase() as Address, BigInt(parsed.amounts[i]));
        }
        return;
      }
    } catch { /* fall back to legacy single-token signature */ }
  }
  addPressure(map, row.token.toLowerCase() as Address, BigInt(row.amount));
}

admin.get("/whoami", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  return c.json({ owner });
});

/** POST /admin/rates  批量更新质押月化利率 */
admin.post("/rates", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    rates?: { asset: string; lock_months: number; monthly_rate_bps: number }[];
  };
  if (!Array.isArray(body.rates)) return c.json({ error: "bad payload" }, 400);

  const now = Math.floor(Date.now() / 1000);
  let updated = 0;
  for (const r of body.rates) {
    if (!STAKE_ASSETS.includes(r.asset as StakeAsset)) continue;
    if (!STAKE_LOCK_MONTHS.includes(r.lock_months as StakeLockMonths)) continue;
    if (!Number.isInteger(r.monthly_rate_bps) || r.monthly_rate_bps < 0 || r.monthly_rate_bps > 100_000) continue;
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO stake_rates (asset, lock_months, monthly_rate_bps, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(r.asset, r.lock_months, r.monthly_rate_bps, now)
      .run();
    invalidateRate(r.asset as StakeAsset, r.lock_months as StakeLockMonths);
    updated++;
  }
  return c.json({ updated });
});

/** GET /admin/genesis-nodes  当前创世节点名单 */
admin.get("/genesis-nodes", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);

  const limitParam = Number(c.req.query("limit") ?? 200);
  const limit = Number.isInteger(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 200;
  const rs = await c.env.DB.prepare(
    `SELECT
        g.address,
        g.tier,
        g.source,
        g.imported_at,
        g.imported_by,
        u.referrer,
        o.id AS order_id,
        o.usdt_in,
        o.stock_granted
       FROM genesis_nodes g
       LEFT JOIN users u ON u.address = g.address
       LEFT JOIN ai_orders o ON o.source_tx_hash = 'genesis-import:' || g.address || ':' || g.tier
      ORDER BY g.imported_at DESC, g.address ASC
      LIMIT ?`,
  )
    .bind(limit)
    .all();

  return c.json({ items: rs.results ?? [] });
});

/** POST /admin/genesis-import  CSV 解析后批量入库 */
admin.post("/genesis-import", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    rows?: { address: string; tier: string; referrer?: string | null }[];
  };
  if (!Array.isArray(body.rows)) return c.json({ error: "bad payload" }, 400);

  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let skipped = 0;
  let ordersCreated = 0;
  let referrersBound = 0;
  const touchedUsers = new Set<string>();
  for (const row of body.rows) {
    if (!/^0x[a-f0-9]{40}$/i.test(row.address)) continue;
    const tier = normalizeAiTier(row.tier);
    if (!tier) continue;
    const referrer = (row.referrer ?? "").trim().toLowerCase();
    if (referrer && !/^0x[a-f0-9]{40}$/.test(referrer)) continue;
    const res = await importGenesisNode(c.env, {
      address: row.address,
      tier,
      source: "csv",
      importedAt: now,
      importedBy: owner,
      referrer: referrer || null,
    });
    if (res.inserted) inserted++;
    else skipped++;
    if (res.orderCreated) ordersCreated++;
    if (res.referrerBound) referrersBound++;
    touchedUsers.add(row.address.toLowerCase());
  }
  for (const user of touchedUsers) await rebuildReferralPath(c.env, user);
  return c.json({ inserted, skipped, ordersCreated, referrersBound });
});

/** POST /admin/genesis-scan  从 BscScan 扫描历史 USDT 入账 */
admin.post("/genesis-scan", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  try {
    const r = await scanGenesisTransfers(c.env, owner);
    return c.json(r);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/** GET /admin/ai-config  / POST /admin/ai-config  AI 量化的交易区间 + 分红比例 */
admin.get("/ai-config", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const directKeys = AI_TIERS.map((tier) => directReferralConfigKey(tier.key));
  const rs = await c.env.DB.prepare(
    `SELECT key, value FROM admin_config WHERE key IN (${["stock_volume_min_usdt", "stock_volume_max_usdt", "stock_dividend_ratio_bps", ...directKeys].map(() => "?").join(",")})`,
  )
    .bind("stock_volume_min_usdt", "stock_volume_max_usdt", "stock_dividend_ratio_bps", ...directKeys)
    .all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of rs.results ?? []) map.set(r.key, r.value);
  const directReferralBps: Partial<Record<AiTierKey, number>> = {};
  for (const tier of AI_TIERS) {
    directReferralBps[tier.key] = Number(map.get(directReferralConfigKey(tier.key)) ?? AI_REFERRAL_DIRECT_BPS[tier.key]);
  }
  return c.json({
    volumeMin: Number(map.get("stock_volume_min_usdt") ?? 100_000),
    volumeMax: Number(map.get("stock_volume_max_usdt") ?? 200_000),
    ratioBps: Number(map.get("stock_dividend_ratio_bps") ?? 100),
    directReferralBps,
  });
});

admin.post("/ai-config", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    volumeMin?: number;
    volumeMax?: number;
    ratioBps?: number;
    directReferralBps?: Partial<Record<AiTierKey, number>>;
  };
  if (
    !Number.isFinite(body.volumeMin) ||
    !Number.isFinite(body.volumeMax) ||
    !Number.isFinite(body.ratioBps) ||
    (body.volumeMin ?? 0) <= 0 ||
    (body.volumeMax ?? 0) < (body.volumeMin ?? 0) ||
    (body.ratioBps ?? -1) < 0
  ) {
    return c.json({ error: "bad payload" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const updates: [string, string][] = [
    ["stock_volume_min_usdt", String(body.volumeMin)],
    ["stock_volume_max_usdt", String(body.volumeMax)],
    ["stock_dividend_ratio_bps", String(Math.floor(body.ratioBps!))],
  ];
  if (body.directReferralBps && typeof body.directReferralBps === "object") {
    for (const tier of AI_TIERS) {
      if (tier.key === "pioneer") {
        updates.push([directReferralConfigKey(tier.key), "0"]);
        continue;
      }
      const bps = body.directReferralBps[tier.key] ?? AI_REFERRAL_DIRECT_BPS[tier.key];
      if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) return c.json({ error: "bad direct referral bps" }, 400);
      updates.push([directReferralConfigKey(tier.key), String(bps)]);
    }
  }
  for (const [k, v] of updates) {
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(k, v, owner, now)
      .run();
  }
  return c.json({ saved: true });
});

/** GET /admin/stock-price  当前股价配置 */
admin.get("/stock-price", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const [quote, market] = await Promise.all([
    getStockQuote(c.env),
    getStockMarketStatus(c.env),
  ]);
  return c.json(withStockMarketStatus(quote, market));
});

/** POST /admin/stock-trade  WTO 股票市场自动/手动休市控制 */
admin.post("/stock-trade", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string; paused?: boolean; manualClosed?: boolean };
  const updates: { mode?: StockMarketMode; manualClosed?: boolean } = {};
  if (body.mode !== undefined) {
    if (body.mode !== "auto" && body.mode !== "manual") return c.json({ error: "bad mode" }, 400);
    updates.mode = body.mode;
  }
  if (body.manualClosed !== undefined || body.paused !== undefined) {
    const manualClosed = body.manualClosed ?? body.paused;
    if (typeof manualClosed !== "boolean") return c.json({ error: "bad paused" }, 400);
    updates.manualClosed = manualClosed;
    if (!updates.mode && body.paused !== undefined) updates.mode = "manual";
  }
  if (!updates.mode && typeof updates.manualClosed !== "boolean") return c.json({ error: "bad payload" }, 400);
  const market = await setStockMarketConfig(c.env, updates, owner);
  return c.json({
    paused: market.closed,
    tradePaused: market.closed,
    marketClosed: market.closed,
    marketMode: market.mode,
    manualClosed: market.manualClosed,
    autoClosed: market.autoClosed,
    marketClosedReason: market.reason,
    market,
  });
});

/** POST /admin/stock-price  WTO 股价手动兜底设值 */
admin.post("/stock-price", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { priceUsdt?: number };
  const p = body.priceUsdt;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
    return c.json({ error: "bad price" }, 400);
  }
  const [quote, market] = await Promise.all([
    setManualStockPrice(c.env, p, owner),
    getStockMarketStatus(c.env),
  ]);
  return c.json(withStockMarketStatus(quote, market));
});

/** POST /admin/stock-price/mode  自动同步开关 */
admin.post("/stock-price/mode", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
  if (body.mode !== "auto" && body.mode !== "manual") return c.json({ error: "bad mode" }, 400);
  const [quote, market] = await Promise.all([
    setStockQuoteMode(c.env, body.mode as StockQuoteMode, owner),
    getStockMarketStatus(c.env),
  ]);
  return c.json(withStockMarketStatus(quote, market));
});

/** POST /admin/stock-price/sync  立即从 Yahoo Finance 同步 WTO 股价 */
admin.post("/stock-price/sync", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const result = await syncStockQuote(c.env, { force: true, updatedBy: owner });
  const market = await getStockMarketStatus(c.env);
  return c.json({ ...result, quote: withStockMarketStatus(result.quote, market) });
});

/** GET /admin/lottery-config / POST  彩票区间 + 票价 */
admin.get("/lottery-config", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const rs = await c.env.DB.prepare(
    "SELECT key, value FROM admin_config WHERE key IN ('lottery_ticket_price_usdt','lottery_weekly_refill_hs','lottery_current_round')",
  ).all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of rs.results ?? []) map.set(r.key, r.value);
  return c.json({
    ticketPriceUsdt: Number(map.get("lottery_ticket_price_usdt") ?? 1),
    weeklyRefillHs: Number(map.get("lottery_weekly_refill_hs") ?? 100_000),
    currentRound: Number(map.get("lottery_current_round") ?? 1),
  });
});

admin.post("/lottery-config", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    ticketPriceUsdt?: number;
    weeklyRefillHs?: number;
  };
  if (
    !Number.isFinite(body.ticketPriceUsdt) ||
    !Number.isFinite(body.weeklyRefillHs) ||
    (body.ticketPriceUsdt ?? 0) <= 0 ||
    (body.weeklyRefillHs ?? 0) < 0
  ) {
    return c.json({ error: "bad payload" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of [
    ["lottery_ticket_price_usdt", String(body.ticketPriceUsdt)],
    ["lottery_weekly_refill_hs", String(body.weeklyRefillHs)],
  ]) {
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(k, v, owner, now)
      .run();
  }
  return c.json({ saved: true });
});

/** POST /admin/lottery-draw  紧急/手动开奖。可选 body: { winning: '123456' } 跳过薄饼同步直接用指定号码 */
admin.post("/lottery-draw", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { winning?: string };
  const force = typeof body.winning === "string" && /^\d{6}$/.test(body.winning) ? body.winning : undefined;
  const { drawLottery } = await import("../lib/lottery-draw");
  const r = await drawLottery(c.env, force);
  return c.json(r);
});

/** GET /admin/airdrop-list / POST  hotshort 账户空投状态流转 */
admin.get("/airdrop-list", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const rs = await c.env.DB.prepare(
    "SELECT id, user, hotshort_account, burn_total, status, submitted_at FROM airdrop_list ORDER BY submitted_at DESC LIMIT 200",
  ).all();
  return c.json({ items: rs.results ?? [] });
});

admin.post("/airdrop-list", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; status?: string };
  if (!body.id || !["pending", "sent", "rejected"].includes(body.status ?? "")) {
    return c.json({ error: "bad payload" }, 400);
  }
  await c.env.DB.prepare("UPDATE airdrop_list SET status = ? WHERE id = ?")
    .bind(body.status, body.id)
    .run();
  return c.json({ saved: true });
});

/** GET /admin/funds  Vault 资金概览（链上余额 + 应付签名待消费） */
admin.get("/funds", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);

  const now = await nowSeconds(c.env);
  const pending = new Map<Address, bigint>();
  const activeNonces = new Set<string>();

  const pendingRows = await c.env.DB.prepare(
    "SELECT nonce, token, amount, deadline, recipients_json FROM claim_signatures WHERE used_at IS NULL",
  ).all<{ nonce: string; token: string; amount: string; deadline: number; recipients_json: string | null }>();
  for (const row of pendingRows.results ?? []) {
    if (row.deadline <= now) continue;
    activeNonces.add(row.nonce);
    addSignaturePressure(pending, row);
  }

  // 质押兑付压力（单独汇总，前端用可读标签展示）
  const stakePressurePrincipal: Record<StakeAsset, bigint> = { USDT: 0n, HS: 0n, LP: 0n };
  let stakePressureInterestHs = 0n;
  let stakeDueCount = 0;
  const stakeRows = await c.env.DB.prepare(
    `SELECT id, asset, amount, entry_value_usdt, lock_months, monthly_rate_bps, claim_nonce
       FROM stake_orders
      WHERE claimed = 0 AND matures_at <= ?`,
  )
    .bind(now)
    .all<{
      id: string;
      asset: StakeAsset;
      amount: string;
      entry_value_usdt: string | null;
      lock_months: number;
      monthly_rate_bps: number;
      claim_nonce: string | null;
    }>();
  for (const row of stakeRows.results ?? []) {
    if (row.claim_nonce && activeNonces.has(row.claim_nonce)) continue;
    const principal = BigInt(row.amount);
    stakePressurePrincipal[row.asset] += principal;

    let entryValueUsdt = BigInt(row.entry_value_usdt ?? "0");
    if (entryValueUsdt <= 0n) entryValueUsdt = await stakeAssetWeiToUsdtWei(c.env, row.asset, principal);
    const interestUsdt =
      (entryValueUsdt * BigInt(row.monthly_rate_bps) * BigInt(row.lock_months)) /
      BigInt(BPS_DENOMINATOR);
    stakePressureInterestHs += await usdtWeiToHsWei(c.env, interestUsdt);
    stakeDueCount++;
  }

  const hsToken = c.env.HS_TOKEN.toLowerCase() as Address;
  const usdtToken = c.env.USDT_TOKEN.toLowerCase() as Address;
  const lotteryRows = await c.env.DB.prepare(
    "SELECT prize_hs, claim_nonce FROM lottery_tickets WHERE claimed = 0 AND prize_hs IS NOT NULL",
  ).all<{ prize_hs: string | null; claim_nonce: string | null }>();
  for (const row of lotteryRows.results ?? []) {
    if (!row.prize_hs || (row.claim_nonce && activeNonces.has(row.claim_nonce))) continue;
    addPressure(pending, hsToken, BigInt(row.prize_hs));
  }

  const top10Rows = await c.env.DB.prepare(
    "SELECT reward_usdt, claim_nonce FROM burn_top10_settlements WHERE claimed = 0",
  ).all<{ reward_usdt: string; claim_nonce: string | null }>();
  for (const row of top10Rows.results ?? []) {
    if (row.claim_nonce && activeNonces.has(row.claim_nonce)) continue;
    addPressure(pending, usdtToken, BigInt(row.reward_usdt));
  }

  const rewardRows = await c.env.DB.prepare(
    "SELECT reward_token, reward_amount, claim_nonce FROM reward_claims WHERE claimed = 0 AND reward_token IN ('HS', 'USDT', 'LP')",
  ).all<{ reward_token: string; reward_amount: string; claim_nonce: string | null }>();
  for (const row of rewardRows.results ?? []) {
    if (row.claim_nonce && activeNonces.has(row.claim_nonce)) continue;
    const token = rewardTokenAddress(c.env, row.reward_token);
    if (token) addPressure(pending, token, BigInt(row.reward_amount));
  }

  const referralRows = await c.env.DB.prepare(
    "SELECT reward_token, reward_amount, claim_nonce FROM referral_rewards WHERE claimed = 0 AND reward_token IN ('HS', 'USDT', 'LP')",
  ).all<{ reward_token: string; reward_amount: string; claim_nonce: string | null }>();
  for (const row of referralRows.results ?? []) {
    if (row.claim_nonce && activeNonces.has(row.claim_nonce)) continue;
    const token = rewardTokenAddress(c.env, row.reward_token);
    if (token) addPressure(pending, token, BigInt(row.reward_amount));
  }

  return c.json({
    pending: [...pending.entries()].map(([token, amount]) => ({ token, pending: amount.toString() })),
    stakePressure: {
      principal: {
        USDT: stakePressurePrincipal.USDT.toString(),
        HS: stakePressurePrincipal.HS.toString(),
        LP: stakePressurePrincipal.LP.toString(),
      },
      interestHs: stakePressureInterestHs.toString(),
      dueOrders: stakeDueCount,
    },
  });
});

admin.get("/agent-accounts", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  await ensureAgentTables(c.env);
  const rows = await c.env.DB.prepare(
    "SELECT address, label, enabled, created_by, created_at, updated_at FROM agent_accounts ORDER BY updated_at DESC",
  ).all<{ address: string; label: string | null; enabled: number; created_by: string; created_at: number; updated_at: number }>();
  const accounts = [];
  for (const row of rows.results ?? []) {
    const users = await listAgentUsers(c.env, row.address);
    const unreadAlerts = row.enabled === 1 ? (await listAgentAlerts(c.env, row.address, 500, true)).length : 0;
    accounts.push({ ...row, teamSize: users.length, unreadAlerts });
  }
  return c.json({ accounts });
});

admin.post("/agent-accounts", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  await ensureAgentTables(c.env);
  const body = (await c.req.json().catch(() => ({}))) as { address?: string; label?: string };
  const address = normalizeAddress(body.address);
  if (!address) return c.json({ error: "bad address" }, 400);
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : null;
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO agent_accounts (address, label, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET label = excluded.label, enabled = 1, updated_at = excluded.updated_at`,
  )
    .bind(address, label, owner, now, now)
    .run();
  return c.json({ saved: true, address });
});

admin.patch("/agent-accounts/:address", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  await ensureAgentTables(c.env);
  const address = normalizeAddress(c.req.param("address"));
  if (!address) return c.json({ error: "bad address" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { label?: string | null; enabled?: boolean };
  const current = await c.env.DB.prepare("SELECT address, label, enabled FROM agent_accounts WHERE address = ?")
    .bind(address)
    .first<{ address: string; label: string | null; enabled: number }>();
  if (!current) return c.json({ error: "not found" }, 404);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) || null : current.label;
  const enabled = typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : current.enabled;
  await c.env.DB.prepare("UPDATE agent_accounts SET label = ?, enabled = ?, updated_at = ? WHERE address = ?")
    .bind(label, enabled, Math.floor(Date.now() / 1000), address)
    .run();
  return c.json({ saved: true, address, enabled: enabled === 1, label });
});

admin.delete("/agent-accounts/:address", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  await ensureAgentTables(c.env);
  const address = normalizeAddress(c.req.param("address"));
  if (!address) return c.json({ error: "bad address" }, 400);
  await c.env.DB.prepare("UPDATE agent_accounts SET enabled = 0, updated_at = ? WHERE address = ?")
    .bind(Math.floor(Date.now() / 1000), address)
    .run();
  return c.json({ saved: true, address, enabled: false });
});

admin.get("/agents", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const q = c.req.query("q")?.toLowerCase().trim() ?? "";

  // 三代团队规模 = 该用户作为 level1/2/3 出现的次数
  const sql = `
    WITH agg AS (
      SELECT
        u.address,
        COALESCE(MAX(o.tier), 'pioneer') AS tier,
        COUNT(DISTINCT o.id) AS ai_orders_count,
        COALESCE(SUM(CAST(o.usdt_in AS REAL)), 0) AS ai_orders_usdt,
        (SELECT COUNT(*) FROM referral_paths rp
           WHERE rp.level1 = u.address OR rp.level2 = u.address OR rp.level3 = u.address) AS team_size,
        (SELECT COALESCE(SUM(CAST(reward_amount AS REAL)), 0)
           FROM referral_rewards rr WHERE rr.user = u.address) AS referral_rewards_usdt
      FROM users u
      LEFT JOIN ai_orders o ON o.user = u.address
      GROUP BY u.address
    )
    SELECT * FROM agg
    WHERE (?1 = '' OR address LIKE ?2 OR tier LIKE ?2)
    ORDER BY referral_rewards_usdt DESC, team_size DESC
    LIMIT 100
  `;
  const like = `%${q}%`;
  const rs = await c.env.DB.prepare(sql).bind(q, like).all();
  return c.json({ agents: rs.results ?? [] });
});

// ===== 高级调试 =====

/** GET /admin/time-debug  当前时间调试信息 */
admin.get("/time-debug", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const info = await getTimeDebugInfo(c.env);
  return c.json(info);
});

/** POST /admin/time-debug  设置时间偏移 { offsetSeconds: number } */
admin.post("/time-debug", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { offsetSeconds?: number };
  if (!Number.isFinite(body.offsetSeconds)) return c.json({ error: "bad offsetSeconds" }, 400);
  await setTimeOffset(c.env, body.offsetSeconds!);
  return c.json(await getTimeDebugInfo(c.env));
});

// 重置数据库所用的表列表（与 test-control 保持一致，额外加 admin_config）
const RESET_TABLES = [
  "claim_signatures",
  "agent_alert_acknowledgements",
  "agent_accounts",
  "referral_rewards",
  "stock_sales",
  "stock_swaps",
  "stock_holdings",
  "ai_stock_releases",
  "ai_dividend_user_daily",
  "ai_dividend_pool_daily",
  "ai_orders",
  "stake_orders",
  "stake_rates",
  "lottery_tickets",
  "lottery_rounds",
  "lottery_commits",
  "burn_top10_settlements",
  "burn_personal_status",
  "burn_rounds",
  "burn_records",
  "lp_tax_receipts",
  "airdrop_list",
  "genesis_nodes",
  "referral_paths",
  "referral_codes",
  "users",
  "reward_claims",
  "admin_config",
];

async function seedDefaults(env: Env, at: number): Promise<void> {
  const rows: [string, string][] = [
    ["stock_price_usdt", "1"],
    ["stock_symbol", "WTO"],
    ["stock_price_provider", "manual"],
    ["stock_quote_mode", "auto"],
    ["stock_market_mode", "auto"],
    ["stock_market_manual_closed", "0"],
    ["stock_trade_paused", "0"],
    ["stock_volume_min_usdt", "100000"],
    ["stock_volume_max_usdt", "200000"],
    ["stock_dividend_ratio_bps", "100"],
    ["lottery_ticket_price_usdt", "1"],
    ["lottery_weekly_refill_hs", "100000"],
    ["lottery_current_round", "1"],
    ["burn_current_round", "1"],
    ["lp_dividend_threshold_usdt", "100"],
    ["lp_dividend_last_at", "0"],
    ["lp_dividend_round", "0"],
    ["pancake_lottery_address", ""],
    ["indexer_last_block", "0"], // 下面会用最新区块覆盖
  ];

  for (const [key, value] of rows) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'admin-reset', ?)",
    )
      .bind(key, value, at)
      .run();
  }

  // 恢复默认质押利率
  for (const asset of ["USDT", "HS", "LP"] as const) {
    const rates: Record<string, Record<number, number>> = {
      USDT: { 1: 50, 3: 200, 6: 400, 12: 800 },
      HS: { 1: 50, 3: 200, 6: 400, 12: 800 },
      LP: { 1: 100, 3: 300, 6: 1000, 12: 2400 },
    };
    for (const [months, bps] of Object.entries(rates[asset])) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO stake_rates (asset, lock_months, monthly_rate_bps, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind(asset, Number(months), bps, at)
        .run();
    }
  }
}

/** POST /admin/reset-db  清空所有业务数据并重置游标到当前区块 */
admin.post("/reset-db", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);

  const at = realNowSeconds();

  // 1. 清空所有业务表
  for (const table of RESET_TABLES) {
    await c.env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  // 2. 重新播种默认配置
  await seedDefaults(c.env, at);

  // 3. 同步游标到最新 BSC 区块
  let latestBlock = 0;
  try {
    const res = await fetch(c.env.RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const json = await res.json() as { result?: string };
    if (json.result) {
      latestBlock = Number(BigInt(json.result));
      await c.env.DB.prepare(
        "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('indexer_last_block', ?, 'admin-reset', ?)",
      )
        .bind(String(latestBlock), at)
        .run();
    }
  } catch { /* RPC 不可用时游标保持 0，索引器会从最近 5 万块开始扫 */ }

  return c.json({
    reset: true,
    tables: RESET_TABLES.length,
    cursorBlock: latestBlock,
    nowSeconds: at,
  });
});

// ===== LP 交易分红管理 =====

/** GET /admin/lp-dividend  当前 LP 分红配置 */
admin.get("/lp-dividend", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const keys = ["lp_dividend_threshold_usdt", "lp_dividend_last_at", "lp_dividend_round"];
  const rs = await c.env.DB.prepare(
    `SELECT key, value FROM admin_config WHERE key IN (${keys.map(() => "?").join(",")})`,
  )
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of rs.results ?? []) map.set(r.key, r.value);

  const thresholdUsdt = map.get("lp_dividend_threshold_usdt") ?? "100";
  const lastAt = Number(map.get("lp_dividend_last_at") ?? "0");
  const round = Number(map.get("lp_dividend_round") ?? "0");
  const receipts = await c.env.DB.prepare(
    "SELECT amount_usdt FROM lp_tax_receipts WHERE settled_round IS NULL",
  ).all<{ amount_usdt: string }>();
  let pendingUsdtWei = 0n;
  for (const row of receipts.results ?? []) pendingUsdtWei += BigInt(row.amount_usdt);

  return c.json({ thresholdUsdt, pendingUsdtWei: pendingUsdtWei.toString(), lastAt, round });
});

/** POST /admin/lp-dividend  设置 LP 分红配置 */
admin.post("/lp-dividend", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    thresholdUsdt?: number | string;
  };
  const now = realNowSeconds();
  const updates: [string, string][] = [];
  if (body.thresholdUsdt !== undefined) {
    const value = String(body.thresholdUsdt).trim();
    if (!/^\d+(\.\d{0,18})?$/.test(value) || Number(value) <= 0) return c.json({ error: "bad payload" }, 400);
    updates.push(["lp_dividend_threshold_usdt", value]);
  }
  if (updates.length === 0) return c.json({ error: "bad payload" }, 400);
  for (const [k, v] of updates) {
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(k, v, owner, now)
      .run();
  }
  return c.json({ saved: true });
});

/** POST /admin/lp-dividend/trigger  立即手动分发一次 */
admin.post("/lp-dividend/trigger", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  try {
    const r = await distributeLpDividend(c.env, { force: true });
    return c.json(r);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});
