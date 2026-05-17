import { Hono } from "hono";
import { createPublicClient, http, formatUnits } from "viem";
import type { Env } from "../env";

export const oracle = new Hono<{ Bindings: Env }>();

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
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

interface PriceCache {
  ts: number;
  price: number;
}
let cache: PriceCache | null = null;
const TTL_MS = 30_000;

oracle.get("/hs-price", async (c) => {
  if (cache && Date.now() - cache.ts < TTL_MS) {
    return c.json({ priceUsdt: cache.price, cached: true });
  }
  const client = createPublicClient({ transport: http(c.env.RPC_URL) });
  const pair = c.env.PANCAKE_PAIR as `0x${string}`;
  const hs = c.env.HS_TOKEN.toLowerCase();
  const [token0, reserves] = await Promise.all([
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token0" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves" }),
  ]);
  const [r0, r1] = reserves as [bigint, bigint, number];
  const isHsToken0 = (token0 as string).toLowerCase() === hs;
  const hsRes = Number(formatUnits(isHsToken0 ? r0 : r1, 18));
  const usdtRes = Number(formatUnits(isHsToken0 ? r1 : r0, 18));
  const price = hsRes > 0 ? usdtRes / hsRes : 0;
  cache = { ts: Date.now(), price };
  return c.json({ priceUsdt: price, cached: false });
});

oracle.get("/stock-price", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT value, updated_at FROM admin_config WHERE key = 'stock_price_usdt'",
  ).first<{ value: string; updated_at: number }>();
  const price = Number(row?.value ?? 1);
  return c.json({
    priceUsdt: price > 0 ? price : 1,
    updatedAt: row?.updated_at ?? null,
  });
});
