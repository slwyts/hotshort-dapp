import { createPublicClient, http, type Address } from "viem";
import type { Env } from "../env";

const VAULT_OWNER_ABI = [
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

let cached: { owner: string; expiresAt: number } | null = null;
const TTL_MS = 60_000;

export async function readVaultOwner(env: Env): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.owner;
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  const owner = await client.readContract({
    address: env.VAULT_ADDRESS as Address,
    abi: VAULT_OWNER_ABI,
    functionName: "owner",
  });
  const lower = (owner as string).toLowerCase();
  cached = { owner: lower, expiresAt: now + TTL_MS };
  return lower;
}
