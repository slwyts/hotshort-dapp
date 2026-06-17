import type { Env } from "../env";
import { computeHit, prizeFromPool } from "./lottery";
import { decimalToWei, usdtWeiToHsWei } from "./pricing";
import {
  PANCAKE_LOTTERY_STATUS,
  readPancakeCurrentLottery,
  readPancakeLottery,
  syncPancakeWinning,
} from "./pancake-lottery";
import { isTestMode, nowSeconds } from "./time";

type DrawLotteryOptions = {
  forceWinning?: string;
  roundNo?: number;
};

async function currentHotshortRound(env: Env): Promise<number> {
  const cur = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_current_round'").first<{ value: string }>();
  return Number(cur?.value ?? 1);
}

async function roundDefaults(env: Env): Promise<{ ticketHsWei: bigint; refillHsWei: bigint }> {
  const refill = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_weekly_refill_hs'").first<{ value: string }>();
  const refillHsWei = BigInt(Math.floor(Number(refill?.value ?? 100_000) * 1e18));
  const ticket = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_ticket_price_usdt'").first<{ value: string }>();
  const ticketHsWei = await usdtWeiToHsWei(env, decimalToWei(Number(ticket?.value ?? 1)));
  return { ticketHsWei, refillHsWei };
}

async function ensureHotshortRound(
  env: Env,
  roundNo: number,
  openedAt: number,
  pancakeLotteryId?: number,
): Promise<void> {
  const existing = await env.DB.prepare("SELECT round_no FROM lottery_rounds WHERE round_no = ?")
    .bind(roundNo)
    .first<{ round_no: number }>();
  if (existing) {
    if (pancakeLotteryId) {
      await env.DB.prepare(
        "UPDATE lottery_rounds SET pancake_lottery_id = COALESCE(pancake_lottery_id, ?), opened_at = ? WHERE round_no = ? AND drawn_at IS NULL",
      )
        .bind(String(pancakeLotteryId), openedAt, roundNo)
        .run();
    }
    return;
  }

  const { ticketHsWei, refillHsWei } = await roundDefaults(env);
  await env.DB.prepare(
    "INSERT INTO lottery_rounds (round_no, ticket_price_hs, pool_hs, opened_at, pancake_lottery_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(roundNo, ticketHsWei.toString(), refillHsWei.toString(), openedAt, pancakeLotteryId ? String(pancakeLotteryId) : null)
    .run();
}

async function mapCurrentRoundToPancake(env: Env, now: number): Promise<{
  mapped: boolean;
  roundNo: number;
  pancakeLotteryId?: number;
  reason?: string;
}> {
  const current = await readPancakeCurrentLottery(env);
  if (!current) return { mapped: false, roundNo: await currentHotshortRound(env), reason: "pancake unavailable" };

  const roundNo = await currentHotshortRound(env);
  await ensureHotshortRound(env, roundNo, current.startTime || now);

  const row = await env.DB.prepare("SELECT pancake_lottery_id, drawn_at FROM lottery_rounds WHERE round_no = ?")
    .bind(roundNo)
    .first<{ pancake_lottery_id: string | null; drawn_at: number | null }>();
  if (row?.drawn_at) return { mapped: false, roundNo, reason: "round already drawn" };
  if (row?.pancake_lottery_id && /^\d+$/.test(row.pancake_lottery_id)) {
    return { mapped: true, roundNo, pancakeLotteryId: Number(row.pancake_lottery_id) };
  }
  if (current.status !== PANCAKE_LOTTERY_STATUS.open) {
    return { mapped: false, roundNo, reason: "pancake round not open" };
  }

  await env.DB.prepare(
    "UPDATE lottery_rounds SET pancake_lottery_id = ?, opened_at = ? WHERE round_no = ? AND drawn_at IS NULL",
  )
    .bind(String(current.lotteryId), current.startTime || now, roundNo)
    .run();
  return { mapped: true, roundNo, pancakeLotteryId: current.lotteryId };
}

/**
 * 同步薄饼官方彩票开奖结果。
 * 若薄饼当期结果暂未可读，返回 pending，不结算本期，也不推进下一轮。
 *
 * 可选 forceWinning：管理员手动指定 6 位中奖号，跳过薄饼同步直接开奖。
 *   适用：测试 / 薄饼当周开奖延迟兜底。
 */
export async function drawLottery(
  env: Env,
  forceWinningOrOptions?: string | DrawLotteryOptions,
): Promise<{ roundNo: number; winning: string; settledTickets: number; pending?: boolean; reason?: string }> {
  const options = typeof forceWinningOrOptions === "string"
    ? { forceWinning: forceWinningOrOptions }
    : forceWinningOrOptions ?? {};
  const now = await nowSeconds(env);
  const roundNo = options.roundNo ?? await currentHotshortRound(env);
  await ensureHotshortRound(env, roundNo, now);

  // 已开过则不重复
  const r = await env.DB.prepare("SELECT drawn_at FROM lottery_rounds WHERE round_no = ?").bind(roundNo).first<{ drawn_at: number | null }>();
  if (r?.drawn_at) return { roundNo, winning: "", settledTickets: 0 };

  let winning: string;
  let pancakeLotteryId: string;
  let source: string;

  if (options.forceWinning && /^\d{6}$/.test(options.forceWinning)) {
    winning = options.forceWinning;
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

  // 下轮先建空映射，随后由 syncPancakeLotteryCycle 绑定到当前 Pancake Open 期。
  await ensureHotshortRound(env, nextRound, now);

  return { roundNo, winning, settledTickets: settled };
}

export async function syncPancakeLotteryCycle(env: Env): Promise<{
  skipped?: boolean;
  mapped?: boolean;
  pending?: boolean;
  drawn?: boolean;
  roundNo?: number;
  pancakeLotteryId?: number;
  winning?: string;
  settledTickets?: number;
  reason?: string;
}> {
  if (isTestMode(env)) return { skipped: true, reason: "test mode" };

  const now = await nowSeconds(env);
  const mapped = await mapCurrentRoundToPancake(env, now);
  if (!mapped.mapped || !mapped.pancakeLotteryId) return mapped;

  const pancake = await readPancakeLottery(env, mapped.pancakeLotteryId);
  if (!pancake?.winning) return { pending: true, roundNo: mapped.roundNo, pancakeLotteryId: mapped.pancakeLotteryId, reason: "pancake result unavailable" };

  const draw = await drawLottery(env, { roundNo: mapped.roundNo });
  if (draw.pending) return { pending: true, roundNo: mapped.roundNo, pancakeLotteryId: mapped.pancakeLotteryId, reason: draw.reason };

  const nextMapped = await mapCurrentRoundToPancake(env, now);
  return {
    drawn: true,
    mapped: nextMapped.mapped,
    roundNo: draw.roundNo,
    pancakeLotteryId: mapped.pancakeLotteryId,
    winning: draw.winning,
    settledTickets: draw.settledTickets,
  };
}
