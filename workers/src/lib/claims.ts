import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireSecret } from "../env";
import { randomNonce } from "./nonce";
import { signClaim } from "./sign";
import { nowSeconds } from "./time";

export interface ClaimSignatureResponse {
  token: Address;
  recipients: Address[];
  amounts: string[];
  amount: string;
  nonce: string;
  deadline: number;
  reason: number;
  signature: Hex;
}

export interface ClaimPayout {
  recipient: Address;
  amount: bigint;
}

export function hashPayouts(payouts: ClaimPayout[]): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }],
    [payouts.map((p) => p.recipient), payouts.map((p) => p.amount)],
  ));
}

export async function createClaimSignature(
  env: Env,
  params: {
    user: Address;
    token: Address;
    amount?: bigint;
    payouts?: ClaimPayout[];
    reason: number;
    now?: number;
  },
): Promise<ClaimSignatureResponse> {
  const payouts = params.payouts ?? [{ recipient: params.user, amount: params.amount ?? 0n }];
  if (payouts.length === 0) throw new Error("claim payouts must not be empty");
  const normalizedPayouts = payouts.map((p) => ({ recipient: p.recipient.toLowerCase() as Address, amount: p.amount }));
  let total = 0n;
  for (const payout of normalizedPayouts) {
    if (payout.amount <= 0n) throw new Error("claim amount must be positive");
    total += payout.amount;
  }

  const now = params.now ?? await nowSeconds(env);
  const vault = env.VAULT_ADDRESS.toLowerCase() as Address;
  const chainId = Number(env.CHAIN_ID);
  const privateKey = requireSecret(env, "SIGNER_PRIVATE_KEY") as `0x${string}`;
  const nonce = randomNonce();
  const deadline = BigInt(now + 30 * 60);
  const token = params.token.toLowerCase() as Address;
  const user = params.user.toLowerCase() as Address;
  const payoutsHash = hashPayouts(normalizedPayouts);

  const signature = await signClaim(privateKey, chainId, vault, {
    user,
    token,
    payoutsHash,
    nonce,
    deadline,
    reason: params.reason,
  });

  await env.DB.prepare(
    `INSERT INTO claim_signatures (nonce, user, token, amount, reason, deadline, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(nonce.toString(), user, token, total.toString(), params.reason, Number(deadline), signature, now)
    .run();

  return {
    token,
    recipients: normalizedPayouts.map((p) => p.recipient),
    amounts: normalizedPayouts.map((p) => p.amount.toString()),
    amount: total.toString(),
    nonce: nonce.toString(),
    deadline: Number(deadline),
    reason: params.reason,
    signature,
  };
}