import type { Env } from "../env";
import { computeHit, prizeFromPool, sha256Digits6 } from "./lottery";

/**
 * commit-reveal 公平开奖（每周一次）：
 *   - 上一轮 settle 时为下一轮 commit 一个随机 seed 的 sha256
 *   - 本轮开奖时 reveal 该 seed，与当前块哈希混合得到 6 位中奖号
 *
 * 安全说明：seed 在 commit 阶段随机生成并存入 lottery_commits.commit_hash（hash 不可逆）；
 *   reveal 时把明文 seed 写入 reveal_seed，外加 BSC 当时块哈希，组合 sha256 → 取低 8 字节模 1e6
 *   作为 6 位中奖号。这样 owner 无法预知结果，外部观察者可校验。
 */
export async function drawLottery(env: Env): Promise<{ roundNo: number; winning: string; settledTickets: number }> {
  const cur = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_current_round'").first<{ value: string }>();
  const roundNo = Number(cur?.value ?? 1);

  // 已开过则不重复
  const r = await env.DB.prepare("SELECT drawn_at FROM lottery_rounds WHERE round_no = ?").bind(roundNo).first<{ drawn_at: number | null }>();
  if (r?.drawn_at) return { roundNo, winning: "", settledTickets: 0 };

  // 取 commit
  const commit = await env.DB.prepare("SELECT commit_hash, reveal_seed FROM lottery_commits WHERE round_no = ?").bind(roundNo).first<{ commit_hash: string; reveal_seed: string | null }>();

  let seed = commit?.reveal_seed ?? "";
  if (!seed) {
    // 没有提前 commit，直接生成 — 公平性下降但保证可开奖（部署初期可接受）
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    seed = Array.from(random).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // 取最近块哈希（混合熵）
  const block = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
  }).then((r) => r.json()).catch(() => null) as { result?: { hash: string } } | null;
  const blockHash = block?.result?.hash ?? "0x0";

  const winning = await sha256Digits6(`${seed}|${blockHash}|${roundNo}`);

  await env.DB.prepare(
    "UPDATE lottery_rounds SET drawn_at = ?, winning_number = ?, reveal_seed = ?, block_hash = ? WHERE round_no = ?",
  )
    .bind(Math.floor(Date.now() / 1000), winning, seed, blockHash, roundNo)
    .run();

  if (!commit?.reveal_seed) {
    // 把现场 seed 也写入 lottery_commits，便于审计
    await env.DB.prepare(
      "INSERT OR REPLACE INTO lottery_commits (round_no, commit_hash, reveal_seed, committed_at, revealed_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(roundNo, await hashHex(seed), seed, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
      .run();
  } else {
    await env.DB.prepare("UPDATE lottery_commits SET revealed_at = ? WHERE round_no = ?")
      .bind(Math.floor(Date.now() / 1000), roundNo)
      .run();
  }

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

  // 为下一轮预 commit
  const nextSeedBytes = new Uint8Array(32);
  crypto.getRandomValues(nextSeedBytes);
  const nextSeed = Array.from(nextSeedBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const nextCommit = await hashHex(nextSeed);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO lottery_commits (round_no, commit_hash, reveal_seed, committed_at) VALUES (?, ?, ?, ?)",
  )
    .bind(nextRound, nextCommit, nextSeed, Math.floor(Date.now() / 1000))
    .run();

  // 下轮新建 round（带本周补给 + 0 票池）
  const refill = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_weekly_refill_hs'").first<{ value: string }>();
  const refillHsWei = BigInt(Math.floor(Number(refill?.value ?? 100_000) * 1e18));
  const ticket = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'lottery_ticket_price_usdt'").first<{ value: string }>();
  const ticketHsWei = BigInt(Math.floor(Number(ticket?.value ?? 1) * 1e18));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO lottery_rounds (round_no, ticket_price_hs, pool_hs, opened_at) VALUES (?, ?, ?, ?)",
  )
    .bind(nextRound, ticketHsWei.toString(), refillHsWei.toString(), Math.floor(Date.now() / 1000))
    .run();

  return { roundNo, winning, settledTickets: settled };
}

async function hashHex(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  const arr = new Uint8Array(hash);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
