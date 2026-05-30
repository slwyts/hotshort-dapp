import { keccak256, encodeAbiParameters, type Hex } from "viem";

export function randomNonce(): bigint {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return BigInt(`0x${hex}`);
}

/** 确定性 nonce：keccak256(prefix, id) → 同一订单永远同一 nonce，防重复签名 */
export function deterministicNonce(prefix: string, id: string): bigint {
  const hash = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }],
      [prefix, id],
    ),
  ) as Hex;
  return BigInt(hash) >> 64n;
}
