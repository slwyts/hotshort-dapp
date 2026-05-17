import type { Env } from "../env";
import { ulid } from "./ulid";
import { nowSeconds } from "./time";

/**
 * 用户首次连接钱包/下单时 upsert，确保 referral_paths 三代回填。
 * referrer 一旦绑定，不可改（防止洗榜）。
 */
export async function upsertUser(env: Env, address: string, referrer: string | null = null) {
  const addr = address.toLowerCase();
  const ref = referrer ? referrer.toLowerCase() : null;
  const now = await nowSeconds(env);

  const existing = await env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
    .bind(addr)
    .first<{ referrer: string | null }>();

  if (existing) {
    await env.DB.prepare("UPDATE users SET last_active_at = ? WHERE address = ?")
      .bind(now, addr)
      .run();
    if (!existing.referrer && ref && ref !== addr) {
      await env.DB.prepare("UPDATE users SET referrer = ? WHERE address = ?")
        .bind(ref, addr)
        .run();
      await rebuildReferralPath(env, addr);
    }
    return;
  }

  await env.DB.prepare(
    "INSERT INTO users (address, referrer, level, joined_at, last_active_at) VALUES (?, ?, 0, ?, ?)",
  )
    .bind(addr, ref && ref !== addr ? ref : null, now, now)
    .run();
  if (ref && ref !== addr) await rebuildReferralPath(env, addr);
}

export async function rebuildReferralPath(env: Env, address: string): Promise<void> {
  const addr = address.toLowerCase();
  // 沿 referrer 链走三跳
  let cursor = addr;
  const ancestors: (string | null)[] = [null, null, null];
  for (let depth = 0; depth < 3; depth++) {
    const row = await env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
      .bind(cursor)
      .first<{ referrer: string | null }>();
    if (!row?.referrer) break;
    ancestors[depth] = row.referrer;
    cursor = row.referrer;
  }
  await env.DB.prepare(
    "INSERT OR REPLACE INTO referral_paths (user, level1, level2, level3, bound_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(addr, ancestors[0], ancestors[1], ancestors[2], await nowSeconds(env))
    .run();
}

export interface CreateStakeOrderInput {
  user: string;
  asset: "USDT" | "HS" | "LP";
  amountWei: string;
  lockMonths: 1 | 3 | 6 | 12;
  monthlyRateBps: number;
  sourceTxHash: string;
}

export async function createStakeOrder(env: Env, i: CreateStakeOrderInput): Promise<string> {
  const id = ulid();
  const startedAt = await nowSeconds(env);
  const matures = startedAt + i.lockMonths * 30 * 86400;
  await env.DB.prepare(
    `INSERT INTO stake_orders
      (id, user, asset, amount, lock_months, monthly_rate_bps, started_at, matures_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      i.user.toLowerCase(),
      i.asset,
      i.amountWei,
      i.lockMonths,
      i.monthlyRateBps,
      startedAt,
      matures,
      i.sourceTxHash,
    )
    .run();
  return id;
}
