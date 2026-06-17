import { Hono } from "hono";
import { type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser, requireBoundUser } from "../lib/users";
import { ulid } from "../lib/ulid";
import { computeHit } from "../lib/lottery";
import { nowSeconds } from "../lib/time";
import { createClaimSignature, getExistingSignature } from "../lib/claims";
import { deterministicNonce } from "../lib/nonce";
import { decimalToWei, usdtWeiToHsWei } from "../lib/pricing";
import { readVaultNonceUsed, verifyVaultDeposit, verifyVaultClaim } from "../lib/vault-events";
import { syncPancakeLotteryCycle } from "../lib/lottery-draw";
import { getPancakeLotteryAddress, PANCAKE_LOTTERY_STATUS, readPancakeLottery } from "../lib/pancake-lottery";
import { LOTTERY_TO_POOL_BPS, BPS_DENOMINATOR } from "@/lib/constants/business-rules";

export const lottery = new Hono<{ Bindings: Env }>();

async function getCurrentRound(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT value FROM admin_config WHERE key = 'lottery_current_round'",
  ).first<{ value: string }>();
  return Number(row?.value ?? 1);
}

async function getTicketPriceUsdt(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT value FROM admin_config WHERE key = 'lottery_ticket_price_usdt'",
  ).first<{ value: string }>();
  return Number(row?.value ?? 1);
}

async function getOrCreateRound(env: Env): Promise<{
  roundNo: number;
  pool_hs: string;
  ticket_price_hs: string;
  opened_at: number;
  pancake_lottery_id: string | null;
}> {
  const roundNo = await getCurrentRound(env);
  const row = await env.DB.prepare(
    "SELECT round_no, pool_hs, ticket_price_hs, opened_at, pancake_lottery_id FROM lottery_rounds WHERE round_no = ?",
  )
    .bind(roundNo)
    .first<{ round_no: number; pool_hs: string; ticket_price_hs: string; opened_at: number; pancake_lottery_id: string | null }>();
  if (row) {
    return {
      roundNo: row.round_no,
      pool_hs: row.pool_hs,
      ticket_price_hs: row.ticket_price_hs,
      opened_at: row.opened_at,
      pancake_lottery_id: row.pancake_lottery_id,
    };
  }

  const refill = await env.DB.prepare(
    "SELECT value FROM admin_config WHERE key = 'lottery_weekly_refill_hs'",
  ).first<{ value: string }>();
  const refillHsWei = BigInt(Math.floor(Number(refill?.value ?? 100_000) * 1e18));

  const ticketUsdt = await getTicketPriceUsdt(env);
  const ticketHsWei = await usdtWeiToHsWei(env, decimalToWei(ticketUsdt));
  const now = await nowSeconds(env);

  await env.DB.prepare(
    "INSERT INTO lottery_rounds (round_no, ticket_price_hs, pool_hs, opened_at) VALUES (?, ?, ?, ?)",
  )
    .bind(roundNo, ticketHsWei.toString(), refillHsWei.toString(), now)
    .run();
  return { roundNo, pool_hs: refillHsWei.toString(), ticket_price_hs: ticketHsWei.toString(), opened_at: now, pancake_lottery_id: null };
}

async function ensurePancakeRoundOpen(env: Env, round: { pancake_lottery_id: string | null }): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const address = await getPancakeLotteryAddress(env);
  if (!address) return { ok: true };
  if (!round.pancake_lottery_id || !/^\d+$/.test(round.pancake_lottery_id)) {
    return { ok: false, error: "pancake lottery round unavailable", status: 503 };
  }
  const pancake = await readPancakeLottery(env, Number(round.pancake_lottery_id));
  if (!pancake) return { ok: false, error: "pancake lottery round unavailable", status: 503 };
  const now = await nowSeconds(env);
  if (pancake.status !== PANCAKE_LOTTERY_STATUS.open || (pancake.endTime > 0 && now >= pancake.endTime)) {
    return { ok: false, error: "lottery round closed", status: 400 };
  }
  return { ok: true };
}

/** GET /lottery/round  当前期 + 我的门票（未开奖 + 已开奖） */
lottery.get("/round", async (c) => {
  await syncPancakeLotteryCycle(c.env).catch(() => null);
  const r = await getOrCreateRound(c.env);
  const user = await requireUser(c);

  const hist = await c.env.DB.prepare(
    "SELECT round_no, winning_number, drawn_at, pool_hs FROM lottery_rounds WHERE drawn_at IS NOT NULL ORDER BY round_no DESC LIMIT 5",
  ).all();

  let myTickets: unknown[] = [];
  if (user) {
    const mt = await c.env.DB.prepare(
      `SELECT t.id, t.round_no, t.numbers, t.paid_hs, t.hit_digits, t.prize_hs, t.claimed,
              r.drawn_at, r.winning_number
         FROM lottery_tickets t
         LEFT JOIN lottery_rounds r ON r.round_no = t.round_no
        WHERE t.user = ?
        ORDER BY t.bought_at DESC
        LIMIT 100`,
    )
      .bind(user)
      .all();
    myTickets = mt.results ?? [];
  }

  return c.json({
    current: {
      roundNo: r.roundNo,
      poolHs: r.pool_hs,
      ticketPriceHs: r.ticket_price_hs,
      openedAt: r.opened_at,
      pancakeLotteryId: r.pancake_lottery_id,
    },
    history: hist.results ?? [],
    myTickets,
  });
});

/**
 * POST /lottery/buy  用户已链上 deposit(purpose=3) 后通知 Worker 入账
 * 入参: { sourceTxHash, entries: ['123456', '654321'] }
 * 兼容旧入参: { sourceTxHash, numbers: '123456', count?: 1 }，表示多张同号。
 *   - 70% 入奖池 / 30% 黑洞由 cron 在结算时根据 deposit 总量切；这里只入门票流水
 */
lottery.post("/buy", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const bound = await requireBoundUser(c.env, user);
  if (!bound) return c.json({ error: "no upline" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    numbers?: string;
    count?: number;
    entries?: string[];
  };
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }
  const entries = Array.isArray(body.entries)
    ? body.entries.map((n) => String(n).trim()).filter(Boolean)
    : Array.from({ length: Math.max(1, Math.floor(body.count ?? 1)) }, () => body.numbers ?? "");
  if (entries.length === 0 || entries.length > 100) return c.json({ error: "count too large" }, 400);
  if (entries.some((n) => !/^\d{6}$/.test(n))) return c.json({ error: "bad numbers (6 digits)" }, 400);

  await upsertUser(c.env, user);
  await syncPancakeLotteryCycle(c.env).catch(() => null);
  const round = await getOrCreateRound(c.env);
  const open = await ensurePancakeRoundOpen(c.env, round);
  if (!open.ok) return c.json({ error: open.error }, open.status as 400 | 503);
  const now = await nowSeconds(c.env);

  // 累计 paid_hs = ticketPriceHs * entries.length
  const paidWei = BigInt(round.ticket_price_hs) * BigInt(entries.length);

  const duplicate = await c.env.DB.prepare("SELECT id FROM lottery_tickets WHERE source_tx_hash = ? LIMIT 1")
    .bind(body.sourceTxHash)
    .first<{ id: string }>();
  if (duplicate) return c.json({ error: "tx already recorded" }, 409);

  await verifyVaultDeposit(c.env, {
    txHash: body.sourceTxHash as Hex,
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    amount: paidWei,
    purpose: 3,
  });

  const ticketIds: string[] = [];
  for (const numbers of entries) {
    const id = ulid();
    await c.env.DB.prepare(
      `INSERT INTO lottery_tickets (id, round_no, user, numbers, paid_hs, bought_at, source_tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, round.roundNo, user, numbers, round.ticket_price_hs, now, body.sourceTxHash)
      .run();
    ticketIds.push(id);
  }

  // 累计 70% 入奖池；剩余 30% 留在 Vault 作为黑洞/金库待处理余额。
  const toPool = (paidWei * BigInt(LOTTERY_TO_POOL_BPS)) / BigInt(BPS_DENOMINATOR);
  const poolRow = await c.env.DB.prepare("SELECT pool_hs FROM lottery_rounds WHERE round_no = ?")
    .bind(round.roundNo)
    .first<{ pool_hs: string }>();
  const nextPool = BigInt(poolRow?.pool_hs ?? "0") + toPool;
  await c.env.DB.prepare("UPDATE lottery_rounds SET pool_hs = ? WHERE round_no = ?")
    .bind(nextPool.toString(), round.roundNo)
    .run();

  return c.json({
    roundNo: round.roundNo,
    count: entries.length,
    entries,
    ticketIds,
    paidHs: paidWei.toString(),
    poolAdditionHs: toPool.toString(),
  });
});

/** POST /lottery/claim  签名领奖（仅命中票） */
lottery.post("/claim", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { ticketId?: string };
  if (!body.ticketId) return c.json({ error: "bad ticketId" }, 400);

  const ticket = await c.env.DB.prepare(
    `SELECT id, user, round_no, numbers, prize_hs, claimed
       FROM lottery_tickets WHERE id = ? AND user = ?`,
  )
    .bind(body.ticketId, user)
    .first<{ id: string; user: string; round_no: number; numbers: string; prize_hs: string | null; claimed: number }>();
  if (!ticket) return c.json({ error: "not found" }, 404);
  if (ticket.claimed) return c.json({ error: "already claimed" }, 400);
  if (!ticket.prize_hs || BigInt(ticket.prize_hs) <= 0n) return c.json({ error: "no prize" }, 400);

  const nonce = deterministicNonce("lottery", ticket.id);
  const now = await nowSeconds(c.env);

  // 已有有效签名 → 直接返回
  const existing = await getExistingSignature(c.env, nonce, now);
  if (existing) {
    const nonceUsed = await readVaultNonceUsed(c.env, nonce).catch(() => false);
    if (nonceUsed) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE claim_signatures SET used_at = ? WHERE nonce = ? AND used_at IS NULL").bind(now, nonce.toString()),
        c.env.DB.prepare("UPDATE lottery_tickets SET claimed = 1 WHERE id = ?").bind(ticket.id),
      ]);
      return c.json({ error: "already claimed" }, 400);
    }
    return c.json(existing);
  }

  const reason = 3; // LOTTERY_PRIZE
  const amount = BigInt(ticket.prize_hs);

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    payouts: [{ recipient: user as Address, amount }],
    reason,
    now,
    nonce,
  });

  // 只记录 nonce，不乐观标记 claimed
  await c.env.DB.prepare("UPDATE lottery_tickets SET claim_nonce = ? WHERE id = ?")
    .bind(claim.nonce, ticket.id)
    .run();

  return c.json(claim);
});

/** POST /lottery/confirm  前端 tx 成功后即时回调 */
lottery.post("/confirm", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { txHash?: string; ticketId?: string };
  if (!body.txHash || !/^0x[a-fA-F0-9]{64}$/.test(body.txHash)) return c.json({ error: "bad tx hash" }, 400);
  if (!body.ticketId) return c.json({ error: "bad ticketId" }, 400);

  const ticket = await c.env.DB.prepare(
    "SELECT id, claim_nonce FROM lottery_tickets WHERE id = ? AND user = ?",
  )
    .bind(body.ticketId, user)
    .first<{ id: string; claim_nonce: string | null }>();
  if (!ticket) return c.json({ error: "ticket not found" }, 404);

  const expectedNonce = ticket.claim_nonce ? BigInt(ticket.claim_nonce) : undefined;
  await verifyVaultClaim(c.env, {
    txHash: body.txHash as Hex,
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    reason: 3,
    nonce: expectedNonce,
  });

  await c.env.DB.prepare("UPDATE lottery_tickets SET claimed = 1 WHERE id = ?")
    .bind(ticket.id)
    .run();

  return c.json({ confirmed: true });
});

// 仅供测试与人工触发（生产由 cron 0 16 * * 0 走）
lottery.post("/admin/draw", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { readVaultOwner } = await import("../lib/vault-owner");
  const owner = await readVaultOwner(c.env).catch(() => null);
  if (!owner || owner !== user) return c.json({ error: "forbidden" }, 403);
  const { drawLottery } = await import("../lib/lottery-draw");
  const r = await drawLottery(c.env);
  return c.json(r);
});

// 计算命中（dev/调试）
lottery.get("/check", async (c) => {
  const ticket = c.req.query("t") || "";
  const winning = c.req.query("w") || "";
  return c.json(computeHit(ticket, winning));
});
