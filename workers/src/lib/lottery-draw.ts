import type { Env } from "../env";
import { computeHit, prizeFromPool } from "./lottery";
import { decimalToWei, usdtWeiToHsWei } from "./pricing";
import { syncPancakeWinning } from "./pancake-lottery";
import { nowSeconds } from "./time";

/**
 * 每周同步薄饼官方彩票开奖结果。
 * 若薄饼当期结果暂未可读，返回 pending，不结算本期，也不推进下一轮。
 *
 * 可选 forceWinning：管理员手动指定 6 位中奖号，跳过薄饼同步直接开奖。
 *   适用：测试 / 薄饼当周开奖延迟兜底。
 */
export async function drawLottery(
  env: Env,
  forceWinning?: string,
): Promise<{ roundNo: number; winning: string; settledTickets: number; pending?: boolean; reason?: string }> {
  const now = await nowSeconds(env);
  const cur = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_current_round'").first<{ value: string }>();
  const roundNo = Number(cur?.value ?? 1);

  // 已开过则不重复
  const r = await env.DB.prepare("SELECT drawn_at FROM lottery_rounds WHERE round_no = ?").bind(roundNo).first<{ drawn_at: number | null }>();
  if (r?.drawn_at) return { roundNo, winning: "", settledTickets: 0 };

  let winning: string;
  let pancakeLotteryId: string;
  let source: string;

  if (forceWinning && /^\d{6}$/.test(forceWinning)) {
    winning = forceWinning;
    pancakeLotteryId = "manual";
    source = "manual";
  } else {
    const synced = await syncPancakeWinning(env, roundNo);
    if (!synced) return { roundNo, winning: "", settledTickets: 0, pending: true, reason: "pancake result unavailable" };
    winning = synced.winning;
    pancakeLotteryId = synced.pancakeLotteryId;
    source = synced.source;
  }

  await env.DB.prepare(
    "UPDATE lottery_rounds SET drawn_at = ?, winning_number = ?, pancake_lottery_id = ?, draw_source = ?, block_hash = ? WHERE round_no = ?",
  )
    .bind(now, winning, pancakeLotteryId, source, source, roundNo)
    .run();

  // 结算所有票
  const round = await env.DB.prepare("SELECT pool_hs FROM lottery_rounds WHERE round_no = ?").bind(roundNo).first<{ pool_hs: string }>();
  const poolWei = BigInt(round?.pool_hs ?? "0");
  const tickets = await env.DB.prepare("SELECT id, numbers FROM lottery_tickets WHERE round_no = ?").bind(roundNo).all<{ id: string; numbers: string }>();

  let settled = 0;
  for (const t of tickets.results ?? []) {
    const r = computeHit(t.numbers, winning);
    if (!r.kind) continue;
    const prize = prizeFromPool(poolWei, r.bps);
    if (prize <= 0n) continue;
    await env.DB.prepare("UPDATE lottery_tickets SET hit_digits = ?, prize_hs = ? WHERE id = ?")
      .bind(r.kind, prize.toString(), t.id)
      .run();
    settled++;
  }

  // 开下一轮
  const nextRound = roundNo + 1;
  await env.DB.prepare("UPDATE admin_config SET value = ? WHERE key = 'lottery_current_round'").bind(String(nextRound)).run();

  // 下轮新建 round（带本周补给 + 0 票池）
  const refill = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_weekly_refill_hs'").first<{ value: string }>();
  const refillHsWei = BigInt(Math.floor(Number(refill?.value ?? 100_000) * 1e18));
  const ticket = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_ticket_price_usdt'").first<{ value: string }>();
  const ticketHsWei = await usdtWeiToHsWei(env, decimalToWei(Number(ticket?.value ?? 1)));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO lottery_rounds (round_no, ticket_price_hs, pool_hs, opened_at) VALUES (?, ?, ?, ?)",
  )
    .bind(nextRound, ticketHsWei.toString(), refillHsWei.toString(), now)
    .run();

  return { roundNo, winning, settledTickets: settled };
}
