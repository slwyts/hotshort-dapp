import type { Env } from "./env";
import { syncVaultEvents } from "./lib/indexer";
import { settleAiDividend } from "./lib/dividend";
import { drawLottery } from "./lib/lottery-draw";
import { settleBurnRound } from "./lib/burn-settle";

/**
 * Cron 入口路由，由 wrangler.toml 中的三条 schedule 触发。
 *   - * /1 * * * *  事件索引
 *   - 0 0 * * *     每日 UTC 00:00（北京时间 08:00）：跑当日股票分红 + 三代返佣
 *   - 0 16 * * 0    每周日 UTC 16:00（北京时间周一 00:00）：彩票开奖 + 燃烧周榜结算
 */
export async function runCron(event: ScheduledEvent, env: Env): Promise<void> {
  const cron = event.cron;
  console.log(`[cron] ${cron} firing at ${new Date(event.scheduledTime).toISOString()}`);

  if (cron === "*/1 * * * *") {
    const r = await syncVaultEvents(env);
    console.log(`[cron] indexer ${r.from}-${r.to}, ${r.count} logs`);
    return;
  }
  if (cron === "0 0 * * *") {
    const r = await settleAiDividend(env);
    console.log(`[cron] ai-dividend`, r);
    return;
  }
  if (cron === "0 16 * * 0") {
    const lot = await drawLottery(env);
    console.log(`[cron] lottery`, lot);
    const burn = await settleBurnRound(env);
    console.log(`[cron] burn-settle`, burn);
    return;
  }
}
