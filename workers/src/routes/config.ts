import { Hono } from "hono";
import type { Env } from "../env";

export const config = new Hono<{ Bindings: Env }>();

/**
 * GET /config —— 前端运行时配置下发。
 * 切换主网真合约 ↔ 测试币只需要改 wrangler [vars] + wrangler deploy，前端无需重建。
 */
config.get("/", (c) => {
  const env = c.env;
  return c.json(
    {
      chainId: Number(env.CHAIN_ID),
      chainName: env.CHAIN_NAME,
      rpcUrl: env.RPC_URL,
      blockExplorerUrl: env.BLOCK_EXPLORER_URL,
      nativeCurrency: {
        name: env.NATIVE_CURRENCY_NAME,
        symbol: env.NATIVE_CURRENCY_SYMBOL,
        decimals: 18,
      },
      contracts: {
        vault: env.VAULT_ADDRESS,
        hsToken: env.HS_TOKEN,
        usdtToken: env.USDT_TOKEN,
        pancakePair: env.PANCAKE_PAIR,
        pancakeLottery: env.PANCAKE_LOTTERY_ADDRESS || null,
      },
    },
    200,
    { "cache-control": "public, max-age=60" },
  );
});
