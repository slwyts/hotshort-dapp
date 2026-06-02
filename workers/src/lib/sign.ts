import { type Address, type Hex, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface ClaimPayload {
  user: Address;
  payoutsHash: Hex;
  nonce: bigint;
  deadline: bigint;
  reason: number;
}

const CLAIM_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Claim(address user,bytes32 payoutsHash,uint256 nonce,uint256 deadline,uint8 reason)",
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
    { name: "payoutsHash", type: "bytes32" },
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
  const sig = await account.signTypedData({
    domain: buildDomain(chainId, vault),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: {
      user: payload.user,
      payoutsHash: payload.payoutsHash,
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
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
      ],
      [CLAIM_TYPEHASH, p.user, p.payoutsHash, p.nonce, p.deadline, p.reason],
    ),
  );
}
