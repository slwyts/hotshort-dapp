import { Hono } from "hono";
import { type Address } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser } from "../lib/users";
import { ulid } from "../lib/ulid";
import { signClaim } from "../lib/sign";
import { requireSecret } from "../env";
import {
  BURN_AIRDROP_MIN_USDT,
  BURN_PERSONAL_DOUBLE_OUT_BPS,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

export const burn = new Hono<{ Bindings: Env }>();

async function getCurrentBurnRound(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = 'burn_current_round'").first<{ value: string }>();
  return Number(row?.value ?? 1);
}

async function ensurePersonalRow(env: Env, user: string): Promise<{ total: bigint; claimed: bigint; out: number | null }> {
  const row = await env.DB.prepare(
    "SELECT total_burned_hs, total_personal_claimed_hs, out_at FROM burn_personal_status WHERE user = ?",
  )
    .bind(user)
    .first<{ total_burned_hs: string; total_personal_claimed_hs: string; out_at: number | null }>();
  if (!row) {
    await env.DB.prepare(
      "INSERT INTO burn_personal_status (user, updated_at) VALUES (?, ?)",
    )
      .bind(user, Math.floor(Date.now() / 1000))
      .run();
    return { total: 0n, claimed: 0n, out: null };
  }
  return {
    total: BigInt(row.total_burned_hs),
    claimed: BigInt(row.total_personal_claimed_hs),
    out: row.out_at,
  };
}

/** GET /burn/me  个人状态 + 当周可领总额 */
burn.get("/me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const status = await ensurePersonalRow(c.env, user);

  // 我作为 Top10 的未领奖
  const top10Pending = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(CAST(reward_hs AS INTEGER)), 0) AS amt FROM burn_top10_settlements WHERE user = ? AND claimed = 0",
  )
    .bind(user)
    .first<{ amt: number | string }>();

  return c.json({
    totalBurnedHs: status.total.toString(),
    personalClaimedHs: status.claimed.toString(),
    out: !!status.out,
    top10PendingHs: String(top10Pending?.amt ?? 0),
    eligibleAirdrop: status.total >= BigInt(Math.floor(BURN_AIRDROP_MIN_USDT * 1e18)),
  });
});

/** GET /burn/leaderboard  当周 Top 100（实时） */
burn.get("/leaderboard", async (c) => {
  const round = await getCurrentBurnRound(c.env);
  const rs = await c.env.DB.prepare(
    `SELECT user, COALESCE(SUM(CAST(hs_amount AS INTEGER)), 0) AS burn_hs
       FROM burn_records WHERE settled_round IS NULL GROUP BY user ORDER BY burn_hs DESC LIMIT 100`,
  ).all<{ user: string; burn_hs: number | string }>();
  return c.json({ round, rows: rs.results ?? [] });
});

/**
 * POST /burn/record  用户已链上 burnHS() 后 Worker 入账
 *   - indexer 也会被动写入 burn_records；此接口让前端可主动触发不等 30s
 *   - 入参: { sourceTxHash, hsAmountWei, referrer? }
 */
burn.post("/record", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    hsAmountWei?: string;
    referrer?: string;
  };
  if (!body.hsAmountWei || !/^\d+$/.test(body.hsAmountWei)) return c.json({ error: "bad amount" }, 400);
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }

  await upsertUser(c.env, user, body.referrer ?? null);

  const id = ulid();
  const amount = BigInt(body.hsAmountWei);
  const now = Math.floor(Date.now() / 1000);

  // 防重：同 tx_hash 已写入则跳过
  const exists = await c.env.DB.prepare("SELECT id FROM burn_records WHERE source_tx_hash = ?").bind(body.sourceTxHash).first();
  if (exists) return c.json({ id: exists.id as string, dedup: true });

  await c.env.DB.prepare(
    `INSERT INTO burn_records (id, user, hs_amount, referrer, burned_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user, amount.toString(), body.referrer?.toLowerCase() ?? null, now, body.sourceTxHash)
    .run();

  // 累计 + 出局判断
  const status = await ensurePersonalRow(c.env, user);
  const total = status.total + amount;
  let outAt = status.out;
  if (!outAt && status.claimed > 0n) {
    // 双倍出局：累计燃烧 ≥ 已领取 × 2
    const cap = (status.claimed * BigInt(BURN_PERSONAL_DOUBLE_OUT_BPS)) / BigInt(BPS_DENOMINATOR);
    if (total >= cap) outAt = now;
  }
  await c.env.DB.prepare(
    "UPDATE burn_personal_status SET total_burned_hs = ?, out_at = COALESCE(out_at, ?), updated_at = ? WHERE user = ?",
  )
    .bind(total.toString(), outAt, now, user)
    .run();

  return c.json({ id, totalBurnedHs: total.toString(), out: !!outAt });
});

/**
 * POST /burn/claim  签名领取（个人燃烧权益 + 当周 Top10）
 *   - 个人燃烧权益：§4.2 "仅可领取 1 次，双倍可出局"。返回单次签名（基于已积累的待领额度）。
 *     这里一个简化：未单独维护"个人池子"，直接以累计燃烧的 20% 折成 HS 一次领取（与"权重分红"档差别由 P3 cron 后续完善）。
 *     P0 阶段先不实现链上签名分发，把 personal_claimed_hs 累加到记录中，方便后台对账，不出签名。
 */
burn.post("/claim/top10", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const rows = await c.env.DB.prepare(
    "SELECT id, reward_hs FROM burn_top10_settlements WHERE user = ? AND claimed = 0",
  )
    .bind(user)
    .all<{ id: string; reward_hs: string }>();

  let total = 0n;
  for (const r of rows.results ?? []) total += BigInt(r.reward_hs);
  if (total <= 0n) return c.json({ amount: "0" });

  const hsToken = c.env.HS_TOKEN as Address;
  const vault = c.env.VAULT_ADDRESS as Address;
  const chainId = Number(c.env.CHAIN_ID);
  const pk = requireSecret(c.env, "SIGNER_PRIVATE_KEY") as `0x${string}`;
  const nonce = BigInt("0x" + ulid().slice(0, 16));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const reason = 4; // BURN_DIVIDEND

  const signature = await signClaim(pk, chainId, vault, {
    user: user as Address,
    token: hsToken,
    amount: total,
    nonce,
    deadline,
    reason,
  });

  await c.env.DB.prepare(
    `INSERT INTO claim_signatures (nonce, user, token, amount, reason, deadline, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(nonce.toString(), user, hsToken.toLowerCase(), total.toString(), reason, Number(deadline), signature, Math.floor(Date.now() / 1000))
    .run();

  await c.env.DB.prepare("UPDATE burn_top10_settlements SET claimed = 1 WHERE user = ? AND claimed = 0")
    .bind(user)
    .run();

  return c.json({
    token: hsToken,
    amount: total.toString(),
    nonce: nonce.toString(),
    deadline: Number(deadline),
    reason,
    signature,
  });
});

/**
 * POST /burn/airdrop/submit  燃烧 ≥1000U 用户提交 hotshort 账户领空投
 */
burn.post("/airdrop/submit", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { hotshortAccount?: string };
  if (!body.hotshortAccount || body.hotshortAccount.length < 3 || body.hotshortAccount.length > 64) {
    return c.json({ error: "bad hotshortAccount" }, 400);
  }

  const status = await ensurePersonalRow(c.env, user);
  if (status.total < BigInt(Math.floor(BURN_AIRDROP_MIN_USDT * 1e18))) {
    return c.json({ error: "not eligible (need >= 1000U burn)" }, 400);
  }

  // 只允许一次提交（pending）；否则覆盖
  const existing = await c.env.DB.prepare("SELECT id FROM airdrop_list WHERE user = ?").bind(user).first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare("UPDATE airdrop_list SET hotshort_account = ?, status = 'pending' WHERE id = ?")
      .bind(body.hotshortAccount, existing.id)
      .run();
    return c.json({ id: existing.id, updated: true });
  }
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO airdrop_list (id, user, hotshort_account, burn_total, status, submitted_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, user, body.hotshortAccount, status.total.toString(), Math.floor(Date.now() / 1000))
    .run();
  return c.json({ id, created: true });
});
