import type { Env } from "../env";

export const TEST_NOW_KEY = "__test_now_seconds";

export function isTestMode(env: Env): boolean {
  return env.E2E_TEST_MODE === "1";
}

export async function nowSeconds(env: Env): Promise<number> {
  if (!isTestMode(env)) return Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?")
    .bind(TEST_NOW_KEY)
    .first<{ value: string }>();
  const configured = Number(row?.value);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : Math.floor(Date.now() / 1000);
}

export async function setTestNowSeconds(env: Env, seconds: number): Promise<number> {
  const now = Math.floor(seconds);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, '__test', ?)",
  )
    .bind(TEST_NOW_KEY, String(now), Math.floor(Date.now() / 1000))
    .run();
  return now;
}

export async function advanceTestNowSeconds(env: Env, seconds: number): Promise<number> {
  const base = await nowSeconds(env);
  return setTestNowSeconds(env, base + Math.floor(seconds));
}

export async function todayBeijing(env: Env): Promise<string> {
  const now = await nowSeconds(env);
  return new Date(now * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
