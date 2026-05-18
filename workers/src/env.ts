/**
 * Worker bindings — 与 wrangler.toml 对应。
 * 缺失任何 secret 时单元测试会跑失败，提示运营在 Cloudflare 控制台补齐。
 */
export interface Env {
  DB: D1Database;

  // vars
  CHAIN_ID: string;
  CHAIN_NAME: string;
  RPC_URL: string;
  BLOCK_EXPLORER_URL: string;
  NATIVE_CURRENCY_NAME: string;
  NATIVE_CURRENCY_SYMBOL: string;
  VAULT_ADDRESS: string;
  HS_TOKEN: string;
  USDT_TOKEN: string;
  PANCAKE_PAIR: string;
  PANCAKE_LOTTERY_ADDRESS?: string;
  E2E_TEST_MODE?: string;

  // secrets
  SIGNER_PRIVATE_KEY?: string;
  JWT_SECRET?: string;
  BSCSCAN_API_KEY?: string;
}

export function requireSecret(env: Env, key: keyof Env): string {
  const v = env[key];
  if (typeof v !== "string" || !v) {
    throw new Error(`missing secret: ${String(key)}`);
  }
  return v;
}
