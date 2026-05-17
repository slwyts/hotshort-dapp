import type { Env } from "../env";
import { ulid } from "./ulid";
import { nowSeconds } from "./time";

export type RewardToken = "HS" | "USDT" | "STOCK";

export interface RewardClaimRow {
  id: string;
  user: string;
  kind: string;
  reward_token: RewardToken;
  reward_amount: string;
  round: number | null;
  source_ref: string;
}

export async function addRewardClaim(env: Env, params: {
  user: string;
  kind: string;
  token: RewardToken;
  amount: bigint;
  round?: number;
  sourceRef: string;
  now?: number;
}): Promise<void> {
  if (params.amount <= 0n) return;
  const now = params.now ?? await nowSeconds(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO reward_claims
       (id, user, kind, reward_token, reward_amount, round, source_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ulid(),
      params.user.toLowerCase(),
      params.kind,
      params.token,
      params.amount.toString(),
      params.round ?? null,
      params.sourceRef,
      now,
    )
    .run();
}

export function sumRewardRows(rows: RewardClaimRow[]): bigint {
  let total = 0n;
  for (const row of rows) total += BigInt(row.reward_amount);
  return total;
}

export async function markRewardRowsClaimed(env: Env, rows: RewardClaimRow[], nonce: string): Promise<void> {
  for (const row of rows) {
    await env.DB.prepare("UPDATE reward_claims SET claimed = 1, claim_signature_nonce = ? WHERE id = ?")
      .bind(nonce, row.id)
      .run();
  }
}