import { createPublicClient, http, formatUnits, type Address } from "viem";
import type { Env } from "../env";

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
] as const;

let cache: { ts: number; price: number } | null = null;
const TTL_MS = 30_000;

/**
 * 从 PancakeSwap pair 实时读 HS / USDT 单价（USDT per HS），30s 内存缓存。
 * 这是 worker 内唯一的 HS 报价入口 —— 彩票门票折算、质押收益、AI 分红、portfolio 都共用。
 *
 * RPC 不可达则返回上一次缓存值；连缓存都没有则返回 0，由调用方判 503。
 */
export async function readHsPriceUsdt(env: Env): Promise<number> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.price;

  try {
    const pair = env.PANCAKE_PAIR.toLowerCase() as Address;
    const hs = env.HS_TOKEN.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(pair)) throw new Error("no pair");

    const client = createPublicClient({ transport: http(env.RPC_URL) });
    const [token0, reserves] = await Promise.all([
      client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token0" }),
      client.readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves" }),
    ]);
    const [r0, r1] = reserves as [bigint, bigint, number];
    const isHsToken0 = (token0 as string).toLowerCase() === hs;
    const hsRes = Number(formatUnits(isHsToken0 ? r0 : r1, 18));
    const usdtRes = Number(formatUnits(isHsToken0 ? r1 : r0, 18));
    const price = hsRes > 0 ? usdtRes / hsRes : 0;
    if (price > 0) {
      cache = { ts: now, price };
      return price;
    }
  } catch {
    // 落到下面返回旧缓存
  }

  return cache?.price ?? 0;
}
