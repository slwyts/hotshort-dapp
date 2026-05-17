import { createPublicClient, http, type Address } from "viem";
import type { Env } from "../env";
import { isTestMode } from "./time";

const PANCAKE_LOTTERY_ABI = [
  {
    name: "currentLotteryId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "viewLottery",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_lotteryId", type: "uint256" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "status", type: "uint8" },
        { name: "startTime", type: "uint256" },
        { name: "endTime", type: "uint256" },
        { name: "priceTicketInCake", type: "uint256" },
        { name: "discountDivisor", type: "uint256" },
        { name: "rewardsBreakdown", type: "uint256" },
        { name: "treasuryFee", type: "uint256" },
        { name: "cakePerBracket", type: "uint256" },
        { name: "countWinnersPerBracket", type: "uint256[6]" },
        { name: "rewardsPerBracket", type: "uint256[6]" },
        { name: "finalNumber", type: "uint256" },
      ],
    }],
  },
] as const;

async function config(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function syncPancakeWinning(env: Env, hotshortRoundNo: number): Promise<{
  winning: string;
  pancakeLotteryId: string;
  source: string;
} | null> {
  if (isTestMode(env)) {
    const forced = await config(env, "__test_lottery_winning");
    if (/^\d{6}$/.test(forced ?? "")) {
      return { winning: forced!, pancakeLotteryId: "__test", source: "__test" };
    }
  }

  const configuredAddress = env.PANCAKE_LOTTERY_ADDRESS || await config(env, "pancake_lottery_address");
  if (!configuredAddress || !/^0x[a-fA-F0-9]{40}$/.test(configuredAddress)) return null;

  const client = createPublicClient({ transport: http(env.RPC_URL) });
  const address = configuredAddress as Address;
  const explicitId = await config(env, `pancake_lottery_id_round_${hotshortRoundNo}`);
  let lotteryId = explicitId && /^\d+$/.test(explicitId)
    ? BigInt(explicitId)
    : await client.readContract({ address, abi: PANCAKE_LOTTERY_ABI, functionName: "currentLotteryId" }) - 1n;

  if (lotteryId <= 0n) return null;
  const lottery = await client.readContract({ address, abi: PANCAKE_LOTTERY_ABI, functionName: "viewLottery", args: [lotteryId] });
  const finalNumber = Array.isArray(lottery)
    ? lottery[10]
    : (lottery as { finalNumber?: bigint }).finalNumber;
  if (typeof finalNumber !== "bigint") return null;
  if (finalNumber < 1_000_000n) return null;

  const winning = (finalNumber % 1_000_000n).toString().padStart(6, "0");
  if (!/^\d{6}$/.test(winning)) return null;
  return { winning, pancakeLotteryId: lotteryId.toString(), source: `pancake:${address}` };
}