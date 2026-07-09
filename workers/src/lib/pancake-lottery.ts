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
        { name: "rewardsBreakdown", type: "uint256[6]" },
        { name: "treasuryFee", type: "uint256" },
        { name: "cakePerBracket", type: "uint256[6]" },
        { name: "countWinnersPerBracket", type: "uint256[6]" },
        { name: "firstTicketId", type: "uint256" },
        { name: "firstTicketIdNextLottery", type: "uint256" },
        { name: "amountCollectedInCake", type: "uint256" },
        { name: "finalNumber", type: "uint32" },
      ],
    }],
  },
] as const;

export const PANCAKE_LOTTERY_STATUS = {
  pending: 0,
  open: 1,
  close: 2,
  claimable: 3,
} as const;

export type PancakeLotteryRound = {
  lotteryId: number;
  status: number;
  startTime: number;
  endTime: number;
  finalNumber: bigint;
  winning: string | null;
  source: string;
};

async function config(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function getPancakeLotteryAddress(env: Env): Promise<Address | null> {
  const configuredAddress = env.PANCAKE_LOTTERY_ADDRESS || await config(env, "pancake_lottery_address");
  if (!configuredAddress || !/^0x[a-fA-F0-9]{40}$/.test(configuredAddress)) return null;
  return configuredAddress as Address;
}

export function winningFromFinalNumber(finalNumber: bigint): string | null {
  if (finalNumber < 1_000_000n) return null;
  const digits = (finalNumber % 1_000_000n).toString().padStart(6, "0");
  if (!/^\d{6}$/.test(digits)) return null;
  // 链上 finalNumber 低位数字对应用户选号的第 1 位，薄饼官网展示时做了倒序；这里保持与官网一致
  return digits.split("").reverse().join("");
}

export async function readPancakeCurrentLotteryId(env: Env): Promise<number | null> {
  const address = await getPancakeLotteryAddress(env);
  if (!address) return null;
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  const id = await client.readContract({ address, abi: PANCAKE_LOTTERY_ABI, functionName: "currentLotteryId" });
  return Number(id);
}

export async function readPancakeLottery(env: Env, lotteryId: number | bigint): Promise<PancakeLotteryRound | null> {
  const address = await getPancakeLotteryAddress(env);
  if (!address) return null;
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  const id = BigInt(lotteryId);
  if (id <= 0n) return null;
  const lottery = await client.readContract({ address, abi: PANCAKE_LOTTERY_ABI, functionName: "viewLottery", args: [id] });
  const status = Array.isArray(lottery) ? Number(lottery[0]) : Number((lottery as { status?: bigint | number }).status ?? 0);
  const startTime = Array.isArray(lottery) ? Number(lottery[1]) : Number((lottery as { startTime?: bigint | number }).startTime ?? 0);
  const endTime = Array.isArray(lottery) ? Number(lottery[2]) : Number((lottery as { endTime?: bigint | number }).endTime ?? 0);
  const rawFinalNumber = Array.isArray(lottery)
    ? lottery[12]
    : (lottery as { finalNumber?: bigint | number }).finalNumber;
  if (rawFinalNumber === undefined) return null;
  const finalNumber = BigInt(rawFinalNumber);
  return {
    lotteryId: Number(id),
    status,
    startTime,
    endTime,
    finalNumber,
    winning: winningFromFinalNumber(finalNumber),
    source: `pancake:${address}`,
  };
}

export async function readPancakeCurrentLottery(env: Env): Promise<PancakeLotteryRound | null> {
  const id = await readPancakeCurrentLotteryId(env);
  return id ? readPancakeLottery(env, id) : null;
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

  const mappedId = await env.DB.prepare("SELECT pancake_lottery_id FROM lottery_rounds WHERE round_no = ?")
    .bind(hotshortRoundNo)
    .first<{ pancake_lottery_id: string | null }>();
  const explicitId = await config(env, `pancake_lottery_id_round_${hotshortRoundNo}`);
  const roundMappedId = mappedId?.pancake_lottery_id && /^\d+$/.test(mappedId.pancake_lottery_id)
    ? BigInt(mappedId.pancake_lottery_id)
    : null;
  let lotteryId = roundMappedId;
  if (!lotteryId && explicitId && /^\d+$/.test(explicitId)) {
    lotteryId = BigInt(explicitId);
  }
  if (!lotteryId) {
    const currentId = await readPancakeCurrentLotteryId(env);
    if (!currentId) return null;
    lotteryId = BigInt(currentId) - 1n;
  }

  if (lotteryId <= 0n) return null;
  const lottery = await readPancakeLottery(env, lotteryId);
  if (!lottery?.winning) return null;
  return { winning: lottery.winning, pancakeLotteryId: lotteryId.toString(), source: lottery.source };
}
