import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireSecret } from "../env";
import { randomNonce } from "./nonce";
import { signClaim } from "./sign";
import { nowSeconds } from "./time";

export interface ClaimSignatureResponse {
  token: Address;
  tokens: Address[];
  recipients: Address[];
  amounts: string[];
  amount: string;
  nonce: string;
  deadline: number;
  reason: number;
  signature: Hex;
}

export interface ClaimPayout {
  token?: Address;
  recipient: Address;
  amount: bigint;
}

interface NormalizedClaimPayout {
  token: Address;
  recipient: Address;
  amount: bigint;
}

function rowToClaimSignature(row: {
  nonce: string;
  user: string;
  token: string;
  amount: string;
  reason: number;
  deadline: number;
  signature: Hex;
  recipients_json: string | null;
}): ClaimSignatureResponse {
  let tokens: Address[] = [];
  let recipients: Address[] = [];
  let amounts: string[] = [];
  if (row.recipients_json) {
    try {
      const parsed = JSON.parse(row.recipients_json) as { tokens?: Address[]; recipients: Address[]; amounts: string[] };
      tokens = parsed.tokens ?? [];
      recipients = parsed.recipients;
      amounts = parsed.amounts;
    } catch { /* ignore */ }
  }
  const fallbackRecipients = recipients.length > 0 ? recipients : [row.user as Address];
  const fallbackAmounts = amounts.length > 0 ? amounts : [row.amount];
  const fallbackTokens = tokens.length > 0 ? tokens : fallbackAmounts.map(() => row.token as Address);
  return {
    token: row.token as Address,
    tokens: fallbackTokens,
    recipients: fallbackRecipients,
    amounts: fallbackAmounts,
    amount: row.amount,
    nonce: row.nonce,
    deadline: row.deadline,
    reason: row.reason,
    signature: row.signature,
  };
}

export function hashPayouts(payouts: NormalizedClaimPayout[]): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address[]" }, { type: "address[]" }, { type: "uint256[]" }],
    [payouts.map((p) => p.token), payouts.map((p) => p.recipient), payouts.map((p) => p.amount)],
  ));
}

/**
 * 查询已有签名（未过期、未使用），用于防重复签发。
 * 如果存在且未过期，返回已有签名；否则返回 null。
 */
export async function getExistingSignature(
  env: Env,
  nonce: bigint,
  now: number,
): Promise<ClaimSignatureResponse | null> {
  const row = await env.DB.prepare(
    "SELECT nonce, user, token, amount, reason, deadline, signature, recipients_json FROM claim_signatures WHERE nonce = ? AND used_at IS NULL AND deadline > ?",
  )
    .bind(nonce.toString(), now)
    .first<{ nonce: string; user: string; token: string; amount: string; reason: number; deadline: number; signature: Hex; recipients_json: string | null }>();
  if (!row) return null;
  return rowToClaimSignature(row);
}

export async function getExistingSignatureForUserReason(
  env: Env,
  user: Address,
  reason: number,
  now: number,
): Promise<ClaimSignatureResponse | null> {
  const row = await env.DB.prepare(
    `SELECT nonce, user, token, amount, reason, deadline, signature, recipients_json
       FROM claim_signatures
      WHERE user = ? AND reason = ? AND used_at IS NULL AND deadline > ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user.toLowerCase(), reason, now)
    .first<{ nonce: string; user: string; token: string; amount: string; reason: number; deadline: number; signature: Hex; recipients_json: string | null }>();
  return row ? rowToClaimSignature(row) : null;
}

export async function createClaimSignature(
  env: Env,
  params: {
    user: Address;
    token?: Address;
    amount?: bigint;
    payouts?: ClaimPayout[];
    reason: number;
    now?: number;
    nonce?: bigint;
  },
): Promise<ClaimSignatureResponse> {
  const payouts = params.payouts ?? [{ recipient: params.user, amount: params.amount ?? 0n }];
  if (payouts.length === 0) throw new Error("claim payouts must not be empty");
  const defaultToken = params.token?.toLowerCase() as Address | undefined;
  const normalizedPayouts = payouts.map((p) => {
    const token = (p.token ?? defaultToken)?.toLowerCase() as Address | undefined;
    if (!token) throw new Error("claim token is required");
    return { token, recipient: p.recipient.toLowerCase() as Address, amount: p.amount };
  });
  let total = 0n;
  for (const payout of normalizedPayouts) {
    if (payout.amount <= 0n) throw new Error("claim amount must be positive");
    total += payout.amount;
  }

  const now = params.now ?? await nowSeconds(env);
  const vault = env.VAULT_ADDRESS.toLowerCase() as Address;
  const chainId = Number(env.CHAIN_ID);
  const privateKey = requireSecret(env, "SIGNER_PRIVATE_KEY") as `0x${string}`;
  const nonce = params.nonce ?? randomNonce();
  const deadline = BigInt(now + 30 * 60);
  const token = normalizedPayouts[0].token;
  const user = params.user.toLowerCase() as Address;
  const payoutsHash = hashPayouts(normalizedPayouts);

  const signature = await signClaim(privateKey, chainId, vault, {
    user,
    payoutsHash,
    nonce,
    deadline,
    reason: params.reason,
  });

  await env.DB.prepare(
    `INSERT OR REPLACE INTO claim_signatures
       (nonce, user, token, amount, reason, deadline, signature, recipients_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM claim_signatures WHERE nonce = ?), ?))`,
  )
    .bind(
      nonce.toString(), user, token, total.toString(), params.reason, Number(deadline), signature,
      JSON.stringify({
        tokens: normalizedPayouts.map((p) => p.token),
        recipients: normalizedPayouts.map((p) => p.recipient),
        amounts: normalizedPayouts.map((p) => p.amount.toString()),
      }),
      nonce.toString(), now,
    )
    .run();

  return {
    token,
    tokens: normalizedPayouts.map((p) => p.token),
    recipients: normalizedPayouts.map((p) => p.recipient),
    amounts: normalizedPayouts.map((p) => p.amount.toString()),
    amount: total.toString(),
    nonce: nonce.toString(),
    deadline: Number(deadline),
    reason: params.reason,
    signature,
  };
}