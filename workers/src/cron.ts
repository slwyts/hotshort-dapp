import type { Env } from "./env";
import { syncVaultEvents } from "./lib/indexer";
import { settleAiDividend } from "./lib/dividend";
import { releaseDueAiStock } from "./lib/ai-releases";
import { syncStockQuote } from "./lib/stocks";
import { drawLottery } from "./lib/lottery-draw";
import { settleBurnRound } from "./lib/burn-settle";
import { distributeLpDividend } from "./lib/lp-dividend";

/**
 * Cron 入口路由，由 wrangler.toml 中的三条 schedule 触发。
 *   - * * * * *      事件索引
 *   - 每 15 分钟：WTO 股价自动同步
 *   - 0 0 * * *     每日 UTC 00:00（北京时间 08:00）：跑当日股票分红 + 三代返佣
 *   - 0 16 * * 0    每周日 UTC 16:00（北京时间周一 00:00）：彩票开奖 + 燃烧周榜结算
 */
export async function runCron(event: ScheduledEvent, env: Env): Promise<void> {
  const cron = event.cron;
  console.log(`[cron] ${cron} firing at ${new Date(event.scheduledTime).toISOString()}`);

  if (cron === "* * * * *" || cron === "*/1 * * * *") {
    const r = await syncVaultEvents(env);
    console.log(`[cron] indexer ${r.from}-${r.to}, ${r.count} logs`);
    // LP 分红每分钟检查是否到期
    try {
      const lp = await distributeLpDividend(env);
      if (!lp.skipped) console.log(`[cron] lp-dividend round=${lp.round} ${lp.recipients} recipients`);
    } catch (e) {
      console.error(`[cron] lp-dividend error`, (e as Error).message);
    }
    return;
  }
  if (cron === "*/15 * * * *") {
    const r = await syncStockQuote(env);
    console.log(`[cron] stock-price`, r);
    return;
  }
  if (cron === "0 0 * * *") {
    const release = await releaseDueAiStock(env);
    console.log(`[cron] ai-release`, release);
    const r = await settleAiDividend(env);
    console.log(`[cron] ai-dividend`, r);
    return;
  }
  if (cron === "0 16 * * 0" || cron === "0 16 * * SUN") {
    const lot = await drawLottery(env);
    console.log(`[cron] lottery`, lot);
    const burn = await settleBurnRound(env);
    console.log(`[cron] burn-settle`, burn);
    return;
  }
}
