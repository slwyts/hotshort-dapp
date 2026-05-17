import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { invalidateRate } from "../lib/rates";
import { scanGenesisTransfers } from "../lib/genesis-scan";
import {
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  type StakeAsset,
  type StakeLockMonths,
} from "@/lib/constants/business-rules";

export const admin = new Hono<{ Bindings: Env }>();

async function requireOwner(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const user = await requireUser(c);
  if (!user) return null;
  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_config WHERE key = 'owner_addresses'",
  ).first<{ value: string }>();
  if (!row) {
    // 部署初期允许配置为空时退回 wrangler vars OWNER 列表
    return null;
  }
  const owners = row.value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return owners.includes(user) ? user : null;
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

/** POST /admin/genesis-import  CSV 解析后批量入库 */
admin.post("/genesis-import", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    rows?: { address: string; tier: string }[];
  };
  if (!Array.isArray(body.rows)) return c.json({ error: "bad payload" }, 400);

  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let skipped = 0;
  for (const row of body.rows) {
    if (!/^0x[a-f0-9]{40}$/i.test(row.address)) continue;
    const res = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO genesis_nodes (address, tier, source, imported_at, imported_by) VALUES (?, ?, 'csv', ?, ?)",
    )
      .bind(row.address.toLowerCase(), row.tier, now, owner)
      .run();
    if ((res.meta?.changes ?? 0) > 0) inserted++;
    else skipped++;
  }
  return c.json({ inserted, skipped });
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
  const rs = await c.env.DB.prepare(
    "SELECT key, value FROM admin_config WHERE key IN ('stock_volume_min_usdt','stock_volume_max_usdt','stock_dividend_ratio_bps')",
  ).all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of rs.results ?? []) map.set(r.key, r.value);
  return c.json({
    volumeMin: Number(map.get("stock_volume_min_usdt") ?? 100_000),
    volumeMax: Number(map.get("stock_volume_max_usdt") ?? 200_000),
    ratioBps: Number(map.get("stock_dividend_ratio_bps") ?? 100),
  });
});

admin.post("/ai-config", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    volumeMin?: number;
    volumeMax?: number;
    ratioBps?: number;
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
  for (const [k, v] of updates) {
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(k, v, owner, now)
      .run();
  }
  return c.json({ saved: true });
});

/** POST /admin/stock-price  非小号股价手动设值 */
admin.post("/stock-price", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { priceUsdt?: number };
  const p = body.priceUsdt;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
    return c.json({ error: "bad price" }, 400);
  }
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('stock_price_usdt', ?, ?, ?)",
  )
    .bind(String(p), owner, Math.floor(Date.now() / 1000))
    .run();
  return c.json({ priceUsdt: p });
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

/** POST /admin/lottery-draw  紧急/手动开奖 */
admin.post("/lottery-draw", async (c) => {
  const owner = await requireOwner(c);
  if (!owner) return c.json({ error: "forbidden" }, 403);
  const { drawLottery } = await import("../lib/lottery-draw");
  const r = await drawLottery(c.env);
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
  // 应付的签名（已签出未上链消费）
  const pendingByToken = await c.env.DB.prepare(
    `SELECT token, COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS pending
       FROM claim_signatures WHERE used_at IS NULL GROUP BY token`,
  ).all<{ token: string; pending: number | string }>();
  return c.json({ pending: pendingByToken.results ?? [] });
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
admin.post("/owners", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    addresses?: string[];
    bootstrapToken?: string;
  };
  // 引导：当 admin_config.owner_addresses 不存在时，允许用 BOOTSTRAP_TOKEN 一次性设置
  const existing = await c.env.DB.prepare(
    "SELECT 1 FROM admin_config WHERE key = 'owner_addresses'",
  ).first();
  if (existing) {
    const owner = await requireOwner(c);
    if (!owner) return c.json({ error: "forbidden" }, 403);
  } else {
    if (!body.bootstrapToken || body.bootstrapToken !== c.env.JWT_SECRET) {
      return c.json({ error: "bootstrap forbidden" }, 403);
    }
  }
  if (!Array.isArray(body.addresses) || body.addresses.length === 0) {
    return c.json({ error: "bad payload" }, 400);
  }
  const value = body.addresses
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[a-f0-9]{40}$/.test(s))
    .join(",");
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('owner_addresses', ?, 'admin', ?)",
  )
    .bind(value, Math.floor(Date.now() / 1000))
    .run();
  return c.json({ owners: value.split(",") });
});
