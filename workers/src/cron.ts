import type { Env } from "./env";
import { syncVaultEvents } from "./lib/indexer";
import { settleAiDividend } from "./lib/dividend";
import { releaseDueAiStock } from "./lib/ai-releases";
import { syncStockQuote } from "./lib/stocks";
import { drawLottery } from "./lib/lottery-draw";
import { settleBurnRound } from "./lib/burn-settle";
import { distributeLpDividend } from "./lib/lp-dividend";
import { distributeBurnRealtime } from "./lib/burn-realtime";
import { nowSeconds } from "./lib/time";

/**
 * 统一调度入口：wrangler.toml 只配一条 `* * * * *`（每分钟触发）。
 * 各任务的执行节奏全部在此用「真实 UTC 时间 + admin_config 上次执行标记」判断，
 * 不再依赖 CF 多条 cron 表达式与字符串匹配。
 *
 * 任务节奏：
 *   - 每分钟：Vault 事件索引 + LP 分红检查
 *   - 每 15 分钟：WTO 股价同步
 *   - 每日 UTC 00:00（北京 08:00）：AI 股票释放 + 股票分红结算
 *   - 每周日 UTC 16:00（北京周一 00:00）：彩票开奖 + 燃烧周榜结算
 */

/** 读取某任务上次执行的 bucket 标记 */
async function lastBucket(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** 写入某任务本次执行的 bucket 标记 */
async function markBucket(env: Env, key: string, bucket: string, now: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'cron', ?)",
  )
    .bind(key, bucket, now)
    .run();
}

/**
 * 判断任务是否到期：当前 bucket 与上次执行 bucket 不同则到期。
 * 到期时先抢占式写入标记（避免并发重复），再返回 true。
 */
async function isDue(env: Env, key: string, bucket: string, now: number): Promise<boolean> {
  const prev = await lastBucket(env, key);
  if (prev === bucket) return false;
  await markBucket(env, key, bucket, now);
  return true;
}

/** UTC 日期桶：YYYY-MM-DD */
function dailyBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 15 分钟桶：floor(epoch / 900) */
function quarterBucket(now: number): string {
  return String(Math.floor(now / 900));
}

/**
 * 周桶：最近一个「周日 UTC 16:00」边界的 ISO 时间戳。
 * 仅当当前时间已越过该边界时才返回边界值，否则返回上一周的边界。
 */
function weeklyBucket(date: Date): string {
  const d = new Date(date.getTime());
  // getUTCDay(): 0=周日。定位到本周日 16:00 UTC。
  const day = d.getUTCDay();
  const boundary = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 16, 0, 0));
  // 把 boundary 调整到「本周日」：减去 day 天即回到本周日
  boundary.setUTCDate(boundary.getUTCDate() - day);
  // 若当前时间还没到这一边界，则归属上一周边界
  if (d.getTime() < boundary.getTime()) boundary.setUTCDate(boundary.getUTCDate() - 7);
  return boundary.toISOString();
}

export async function runCron(_event: ScheduledEvent, env: Env): Promise<void> {
  // 尊重管理员时间加速（time_offset_seconds）与测试模式（E2E_TEST_MODE=1 → __test_now_seconds）。
  // CF 仍按真实时钟每分钟触发，但任务到期判断使用业务时间，便于测试环境快进结算。
  const now = await nowSeconds(env);
  const date = new Date(now * 1000);
  console.log(`[cron] tick at ${date.toISOString()}`);

  // 每分钟：Vault 事件索引
  try {
    const r = await syncVaultEvents(env);
    console.log(`[cron] indexer ${r.from}-${r.to}, ${r.count} logs`);
  } catch (e) {
    console.error(`[cron] indexer error`, (e as Error).message);
  }

  // 每分钟：燃烧实时分配（权重累加器 + 推广直发 + 黑洞记账），兜底 record 未即时触发的部分
  try {
    const d = await distributeBurnRealtime(env);
    if (d.processed > 0) console.log(`[cron] burn-realtime ${d.processed} records`);
  } catch (e) {
    console.error(`[cron] burn-realtime error`, (e as Error).message);
  }

  // 每分钟：LP 分红检查（内部有阈值保护，不够门槛自动跳过）
  try {
    const lp = await distributeLpDividend(env);
    if (!lp.skipped) console.log(`[cron] lp-dividend round=${lp.round} ${lp.recipients} recipients`);
  } catch (e) {
    console.error(`[cron] lp-dividend error`, (e as Error).message);
  }

  // 每 15 分钟：股价同步
  if (await isDue(env, "cron_last_stock", quarterBucket(now), now)) {
    try {
      const r = await syncStockQuote(env);
      console.log(`[cron] stock-price`, r);
    } catch (e) {
      console.error(`[cron] stock-price error`, (e as Error).message);
    }
  }

  // 每日 UTC 00:00：AI 股票释放 + 股票分红结算
  if (await isDue(env, "cron_last_daily", dailyBucket(date), now)) {
    try {
      const release = await releaseDueAiStock(env);
      console.log(`[cron] ai-release`, release);
      const r = await settleAiDividend(env);
      console.log(`[cron] ai-dividend`, r);
    } catch (e) {
      console.error(`[cron] daily error`, (e as Error).message);
    }
  }

  // 每周日 UTC 16:00：彩票开奖 + 燃烧周榜结算
  if (await isDue(env, "cron_last_weekly", weeklyBucket(date), now)) {
    try {
      const lot = await drawLottery(env);
      console.log(`[cron] lottery`, lot);
      const burn = await settleBurnRound(env);
      console.log(`[cron] burn-settle`, burn);
    } catch (e) {
      console.error(`[cron] weekly error`, (e as Error).message);
    }
  }
}
