import { createPublicClient, http, type Address } from "viem";
import type { Env } from "../env";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export async function readTokenBalance(env: Env, token: Address, account: Address): Promise<bigint> {
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  return client.readContract({ address: token, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account] });
}