import { createPublicClient, http, type Address } from "viem";
import type { Env } from "../env";
import { getHsPriceUsdt, getStockPriceUsdt } from "./stocks";
import type { StakeAsset } from "@/lib/constants/business-rules";

const SCALE = 10n ** 18n;

const PAIR_ABI = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export function decimalToWei(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value * 1e18));
}

export async function hsPriceWei(env: Env): Promise<bigint> {
  return decimalToWei(await getHsPriceUsdt(env));
}

export async function stockPriceWei(env: Env): Promise<bigint> {
  return decimalToWei(await getStockPriceUsdt(env));
}

export async function usdtWeiToHsWei(env: Env, usdtWei: bigint): Promise<bigint> {
  if (usdtWei <= 0n) return 0n;
  const price = await hsPriceWei(env);
  return price > 0n ? (usdtWei * SCALE) / price : 0n;
}

export async function hsWeiToUsdtWei(env: Env, hsWei: bigint): Promise<bigint> {
  if (hsWei <= 0n) return 0n;
  const price = await hsPriceWei(env);
  return (hsWei * price) / SCALE;
}

export async function stockWeiToUsdtWei(env: Env, stockWei: bigint): Promise<bigint> {
  if (stockWei <= 0n) return 0n;
  const price = await stockPriceWei(env);
  return (stockWei * price) / SCALE;
}

export async function usdtWeiToStockWei(env: Env, usdtWei: bigint): Promise<bigint> {
  if (usdtWei <= 0n) return 0n;
  const price = await stockPriceWei(env);
  return price > 0n ? (usdtWei * SCALE) / price : 0n;
}

export function tokenForStakeAsset(env: Env, asset: StakeAsset): Address {
  if (asset === "USDT") return env.USDT_TOKEN.toLowerCase() as Address;
  if (asset === "HS") return env.HS_TOKEN.toLowerCase() as Address;
  return env.PANCAKE_PAIR.toLowerCase() as Address;
}

export async function lpWeiToUsdtWei(env: Env, lpWei: bigint): Promise<bigint> {
  if (lpWei <= 0n) return 0n;
  const pair = env.PANCAKE_PAIR as Address;
  if (!/^0x[a-fA-F0-9]{40}$/.test(pair)) return 0n;

  const client = createPublicClient({ transport: http(env.RPC_URL) });
  const [token0, token1, reserves, totalSupply] = await Promise.all([
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token0" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token1" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "totalSupply" }),
  ]);
  if (totalSupply === 0n) return 0n;

  const [reserve0, reserve1] = reserves as readonly [bigint, bigint, number];
  const hs = env.HS_TOKEN.toLowerCase();
  const usdt = env.USDT_TOKEN.toLowerCase();
  const t0 = String(token0).toLowerCase();
  const t1 = String(token1).toLowerCase();

  let hsReserve = 0n;
  let usdtReserve = 0n;
  if (t0 === hs && t1 === usdt) {
    hsReserve = reserve0;
    usdtReserve = reserve1;
  } else if (t0 === usdt && t1 === hs) {
    hsReserve = reserve1;
    usdtReserve = reserve0;
  } else {
    return 0n;
  }

  const pairValueUsdt = usdtReserve + await hsWeiToUsdtWei(env, hsReserve);
  return (pairValueUsdt * lpWei) / totalSupply;
}

export async function stakeAssetWeiToUsdtWei(env: Env, asset: StakeAsset, amountWei: bigint): Promise<bigint> {
  if (asset === "USDT") return amountWei;
  if (asset === "HS") return hsWeiToUsdtWei(env, amountWei);
  return lpWeiToUsdtWei(env, amountWei);
}