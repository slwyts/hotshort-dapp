import type { Env } from "../env";

export const TEST_NOW_KEY = "__test_now_seconds";
export const TIME_OFFSET_KEY = "time_offset_seconds";

export function isTestMode(env: Env): boolean {
  return env.E2E_TEST_MODE === "1";
}

/** 始终返回真实世界时间（不受偏移/测试模式影响），用于健康检查等场景 */
export function realNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 读取时间偏移量（秒），默认 0 */
export async function getTimeOffset(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?")
    .bind(TIME_OFFSET_KEY)
    .first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/** 设置时间偏移量（秒），返回设置后的系统时间 */
export async function setTimeOffset(env: Env, offsetSeconds: number): Promise<number> {
  const sec = Math.floor(offsetSeconds);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'admin', ?)",
  )
    .bind(TIME_OFFSET_KEY, String(sec), realNowSeconds())
    .run();
  return sec;
}

/**
 * 获取当前系统时间（秒）。
 * 优先级：测试模式（E2E_TEST_MODE=1）→ 时间偏移 → 真实时间
 */
export async function nowSeconds(env: Env): Promise<number> {
  // 测试模式优先——完全替换时间
  if (isTestMode(env)) {
    const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?")
      .bind(TEST_NOW_KEY)
      .first<{ value: string }>();
    const configured = Number(row?.value);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  }
  // 正常模式：真实时间 + 偏移
  const offset = await getTimeOffset(env);
  return realNowSeconds() + offset;
}

export async function setTestNowSeconds(env: Env, seconds: number): Promise<number> {
  const now = Math.floor(seconds);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, '__test', ?)",
  )
    .bind(TEST_NOW_KEY, String(now), realNowSeconds())
    .run();
  return now;
}

export async function advanceTestNowSeconds(env: Env, seconds: number): Promise<number> {
  const base = await nowSeconds(env);
  return setTestNowSeconds(env, base + Math.floor(seconds));
}

/** 时间调试信息（均以 UTC+8 显示） */
export async function getTimeDebugInfo(env: Env): Promise<{
  systemTime: number;
  realTime: number;
  offsetSeconds: number;
  testMode: boolean;
}> {
  const offset = await getTimeOffset(env);
  return {
    systemTime: realNowSeconds() + offset,
    realTime: realNowSeconds(),
    offsetSeconds: offset,
    testMode: isTestMode(env),
  };
}

export async function todayBeijing(env: Env): Promise<string> {
  const now = await nowSeconds(env);
  return new Date(now * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
