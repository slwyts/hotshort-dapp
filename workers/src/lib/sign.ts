import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  keccak256,
  encodeAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface ClaimPayload {
  user: Address;
  token: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  reason: number;
}

const CLAIM_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Claim(address user,address token,uint256 amount,uint256 nonce,uint256 deadline,uint8 reason)",
  ) as Uint8Array,
);

export function buildDomain(chainId: number, vault: Address) {
  return {
    name: "Hotshort",
    version: "1",
    chainId,
    verifyingContract: vault,
  } as const;
}

export const CLAIM_TYPES = {
  Claim: [
    { name: "user", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "reason", type: "uint8" },
  ],
} as const;

/**
 * 用 Worker signer 私钥对 claim payload 做 EIP-712 签名。
 */
export async function signClaim(
  privateKey: Hex,
  chainId: number,
  vault: Address,
  payload: ClaimPayload,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, transport: http() });
  const sig = await client.signTypedData({
    domain: buildDomain(chainId, vault),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: {
      user: payload.user,
      token: payload.token,
      amount: payload.amount,
      nonce: payload.nonce,
      deadline: payload.deadline,
      reason: payload.reason,
    },
  });
  return sig;
}

/** 仅供后端入库参考，不参与链上验证 */
export function claimStructHash(p: ClaimPayload): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
      ],
      [CLAIM_TYPEHASH, p.user, p.token, p.amount, p.nonce, p.deadline, p.reason],
    ),
  );
}
