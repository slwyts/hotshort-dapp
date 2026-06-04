import { Hono } from "hono";
import type { Env } from "../env";
import { syncVaultEvents } from "../lib/indexer";
import { settleAiDividend } from "../lib/dividend";
import { releaseDueAiStock } from "../lib/ai-releases";
import { syncStockQuote } from "../lib/stocks";
import { drawLottery } from "../lib/lottery-draw";
import { settleBurnRound } from "../lib/burn-settle";
import { distributeBurnRealtime } from "../lib/burn-realtime";
import { advanceTestNowSeconds, isTestMode, nowSeconds, setTestNowSeconds } from "../lib/time";
import {
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  STAKE_DEFAULT_RATES_BPS,
  type StakeAsset,
} from "@/lib/constants/business-rules";

export const testControl = new Hono<{ Bindings: Env }>();

const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

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
  "admin_config",
];

testControl.use("*", async (c, next) => {
  if (!isTestMode(c.env)) return c.json({ error: "not found" }, 404);
  await next();
});

async function seedDefaults(env: Env, at: number): Promise<void> {
  const rows: [string, string][] = [
    ["owner_addresses", OWNER],
    ["stock_price_usdt", "1"],
    ["stock_symbol", "WTO"],
    ["stock_price_provider", "manual"],
    ["stock_quote_mode", "manual"],
    ["stock_volume_min_usdt", "100000"],
    ["stock_volume_max_usdt", "100000"],
    ["stock_dividend_ratio_bps", "100"],
    ["lottery_current_round", "1"],
    ["lottery_ticket_price_usdt", "1"],
    ["lottery_weekly_refill_hs", "100000"],
    ["burn_current_round", "1"],
    ["burn_weight_acc_per_share", "0"],
    ["burn_weight_total_share", "0"],
    ["burn_blackhole_total_usdt", "0"],
    ["lp_dividend_threshold_usdt", "100"],
    ["lp_dividend_last_at", "0"],
    ["lp_dividend_round", "0"],
    ["__test_now_seconds", String(at)],
  ];

  for (const [key, value] of rows) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, '__test', ?)",
    )
      .bind(key, value, at)
      .run();
  }

  for (const asset of STAKE_ASSETS) {
    for (const months of STAKE_LOCK_MONTHS) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO stake_rates (asset, lock_months, monthly_rate_bps, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind(asset, months, STAKE_DEFAULT_RATES_BPS[asset as StakeAsset][months], at)
        .run();
    }
  }
}

testControl.get("/time", async (c) => c.json({ nowSeconds: await nowSeconds(c.env) }));

testControl.post("/time/set", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { nowSeconds?: number };
  if (!Number.isFinite(body.nowSeconds)) return c.json({ error: "bad nowSeconds" }, 400);
  return c.json({ nowSeconds: await setTestNowSeconds(c.env, body.nowSeconds!) });
});

testControl.post("/time/advance", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { seconds?: number };
  if (!Number.isFinite(body.seconds)) return c.json({ error: "bad seconds" }, 400);
  return c.json({ nowSeconds: await advanceTestNowSeconds(c.env, body.seconds!) });
});

testControl.post("/config", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string };
  if (!body.key || !/^[a-zA-Z0-9_:.\-]+$/.test(body.key)) return c.json({ error: "bad key" }, 400);
  if (typeof body.value !== "string") return c.json({ error: "bad value" }, 400);
  const now = await nowSeconds(c.env);
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, '__test', ?)",
  )
    .bind(body.key, body.value, now)
    .run();
  return c.json({ key: body.key, value: body.value });
});

testControl.post("/lottery/winning", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { winning?: string | null };
  if (body.winning !== null && !/^\d{6}$/.test(body.winning ?? "")) return c.json({ error: "bad winning" }, 400);
  if (body.winning === null) {
    await c.env.DB.prepare("DELETE FROM admin_config WHERE key = '__test_lottery_winning'").run();
    return c.json({ cleared: true });
  }
  const now = await nowSeconds(c.env);
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('__test_lottery_winning', ?, '__test', ?)",
  )
    .bind(body.winning, now)
    .run();
  return c.json({ winning: body.winning });
});

testControl.post("/cron", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { job?: string };
  switch (body.job) {
    case "indexer":
      return c.json({ job: body.job, result: await syncVaultEvents(c.env) });
    case "ai-dividend":
      return c.json({ job: body.job, result: await settleAiDividend(c.env) });
    case "ai-release":
      return c.json({ job: body.job, result: await releaseDueAiStock(c.env) });
    case "stock-price":
      return c.json({ job: body.job, result: await syncStockQuote(c.env) });
    case "lottery":
      return c.json({ job: body.job, result: await drawLottery(c.env) });
    case "burn-realtime":
      return c.json({ job: body.job, result: await distributeBurnRealtime(c.env) });
    case "burn-weekly":
      return c.json({ job: body.job, result: await settleBurnRound(c.env) });
    case "weekly": {
      const lottery = await drawLottery(c.env);
      const burn = await settleBurnRound(c.env);
      return c.json({ job: body.job, result: { lottery, burn } });
    }
    default:
      return c.json({ error: "bad job" }, 400);
  }
});

testControl.post("/reset", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { nowSeconds?: number };
  const at = Number.isFinite(body.nowSeconds) ? Math.floor(body.nowSeconds!) : Math.floor(Date.now() / 1000);
  for (const table of RESET_TABLES) await c.env.DB.prepare(`DELETE FROM ${table}`).run();
  await seedDefaults(c.env, at);
  return c.json({ reset: true, nowSeconds: at });
});
