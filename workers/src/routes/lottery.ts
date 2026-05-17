import { Hono } from "hono";
import { type Address } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser } from "../lib/users";
import { ulid } from "../lib/ulid";
import { signClaim } from "../lib/sign";
import { computeHit, prizeFromPool } from "../lib/lottery";
import { requireSecret } from "../env";
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

async function getOrCreateRound(env: Env): Promise<{ roundNo: number; pool_hs: string; ticket_price_hs: string }> {
  const roundNo = await getCurrentRound(env);
  const row = await env.DB.prepare(
    "SELECT round_no, pool_hs, ticket_price_hs FROM lottery_rounds WHERE round_no = ?",
  )
    .bind(roundNo)
    .first<{ round_no: number; pool_hs: string; ticket_price_hs: string }>();
  if (row) return { roundNo: row.round_no, pool_hs: row.pool_hs, ticket_price_hs: row.ticket_price_hs };

  const refill = await env.DB.prepare(
    "SELECT value FROM admin_config WHERE key = 'lottery_weekly_refill_hs'",
  ).first<{ value: string }>();
  const refillHsWei = BigInt(Math.floor(Number(refill?.value ?? 100_000) * 1e18));

  const ticketUsdt = await getTicketPriceUsdt(env);
  const ticketHsWei = BigInt(Math.floor(ticketUsdt * 1e18));

  await env.DB.prepare(
    "INSERT INTO lottery_rounds (round_no, ticket_price_hs, pool_hs, opened_at) VALUES (?, ?, ?, ?)",
  )
    .bind(roundNo, ticketHsWei.toString(), refillHsWei.toString(), Math.floor(Date.now() / 1000))
    .run();
  return { roundNo, pool_hs: refillHsWei.toString(), ticket_price_hs: ticketHsWei.toString() };
}

/** GET /lottery/round  当前期 + 我的门票（未开奖 + 已开奖） */
lottery.get("/round", async (c) => {
  const r = await getOrCreateRound(c.env);
  const user = await requireUser(c);

  const hist = await c.env.DB.prepare(
    "SELECT round_no, winning_number, drawn_at, pool_hs FROM lottery_rounds WHERE drawn_at IS NOT NULL ORDER BY round_no DESC LIMIT 5",
  ).all();

  let myTickets: unknown[] = [];
  if (user) {
    const mt = await c.env.DB.prepare(
      "SELECT id, round_no, numbers, paid_hs, hit_digits, prize_hs, claimed FROM lottery_tickets WHERE user = ? ORDER BY bought_at DESC LIMIT 100",
    )
      .bind(user)
      .all();
    myTickets = mt.results ?? [];
  }

  return c.json({
    current: { roundNo: r.roundNo, poolHs: r.pool_hs, ticketPriceHs: r.ticket_price_hs },
    history: hist.results ?? [],
    myTickets,
  });
});

/**
 * POST /lottery/buy  用户已链上 deposit(purpose=3) 后通知 Worker 入账
 * 入参: { sourceTxHash, numbers: '123456', count?: 1 }
 *   - count 一般为 1；多张同号一次性买
 *   - 70% 入奖池 / 30% 黑洞由 cron 在结算时根据 deposit 总量切；这里只入门票流水
 */
lottery.post("/buy", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    numbers?: string;
    count?: number;
    referrer?: string;
  };
  if (!/^\d{6}$/.test(body.numbers ?? "")) return c.json({ error: "bad numbers (6 digits)" }, 400);
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }
  const count = Math.max(1, Math.floor(body.count ?? 1));
  if (count > 100) return c.json({ error: "count too large" }, 400);

  await upsertUser(c.env, user, body.referrer ?? null);
  const round = await getOrCreateRound(c.env);

  // 累计 paid_hs = ticketPriceHs * count
  const paidWei = BigInt(round.ticket_price_hs) * BigInt(count);

  for (let i = 0; i < count; i++) {
    const id = ulid();
    await c.env.DB.prepare(
      `INSERT INTO lottery_tickets (id, round_no, user, numbers, paid_hs, bought_at, source_tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, round.roundNo, user, body.numbers!, round.ticket_price_hs, Math.floor(Date.now() / 1000), body.sourceTxHash)
      .run();
  }

  // 累计 70% 入奖池（30% 视为销毁，由 admin 在结算时实际转入黑洞）
  const toPool = (paidWei * BigInt(LOTTERY_TO_POOL_BPS)) / BigInt(BPS_DENOMINATOR);
  await c.env.DB.prepare("UPDATE lottery_rounds SET pool_hs = CAST((CAST(pool_hs AS INTEGER) + ?) AS TEXT) WHERE round_no = ?")
    .bind(toPool.toString(), round.roundNo)
    .run();

  return c.json({ roundNo: round.roundNo, count, paidHs: paidWei.toString(), poolAdditionHs: toPool.toString() });
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

  const hsToken = c.env.HS_TOKEN as Address;
  const vault = c.env.VAULT_ADDRESS as Address;
  const chainId = Number(c.env.CHAIN_ID);
  const pk = requireSecret(c.env, "SIGNER_PRIVATE_KEY") as `0x${string}`;
  const nonce = BigInt("0x" + ulid().slice(0, 16));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const reason = 3; // LOTTERY_PRIZE
  const amount = BigInt(ticket.prize_hs);

  const signature = await signClaim(pk, chainId, vault, {
    user: user as Address,
    token: hsToken,
    amount,
    nonce,
    deadline,
    reason,
  });

  await c.env.DB.prepare(
    `INSERT INTO claim_signatures (nonce, user, token, amount, reason, deadline, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(nonce.toString(), user, hsToken.toLowerCase(), amount.toString(), reason, Number(deadline), signature, Math.floor(Date.now() / 1000))
    .run();

  await c.env.DB.prepare("UPDATE lottery_tickets SET claimed = 1 WHERE id = ?")
    .bind(ticket.id)
    .run();

  return c.json({
    token: hsToken,
    amount: amount.toString(),
    nonce: nonce.toString(),
    deadline: Number(deadline),
    reason,
    signature,
  });
});

// 仅供测试与人工触发（生产由 cron 0 16 * * 0 走）
lottery.post("/admin/draw", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const ownerRow = await c.env.DB.prepare("SELECT value FROM admin_config WHERE key = 'owner_addresses'").first<{ value: string }>();
  if (!ownerRow || !ownerRow.value.toLowerCase().split(",").map((s) => s.trim()).includes(user)) {
    return c.json({ error: "forbidden" }, 403);
  }
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
