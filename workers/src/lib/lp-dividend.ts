import type { Env } from "../env";
import { ulid } from "./ulid";
import { nowSeconds } from "./time";
import {
  BURN_LP_DIVIDEND_HOLDER_BPS,
  BURN_LP_DIVIDEND_TOP10_BPS,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

interface LpDividendConfig {
  amountHs: bigint;
  intervalSeconds: number;
  lastAt: number;
  round: number;
}

async function readConfig(env: Env): Promise<LpDividendConfig> {
  const keys = [
    "lp_dividend_amount_hs",
    "lp_dividend_interval_seconds",
    "lp_dividend_last_at",
    "lp_dividend_round",
  ];
  const rows = await env.DB.prepare(
    `SELECT key, value FROM admin_config WHERE key IN (${keys.map(() => "?").join(",")})`,
  )
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const r of rows.results ?? []) map.set(r.key, r.value);

  return {
    amountHs: BigInt(map.get("lp_dividend_amount_hs") ?? "100000") * 10n ** 18n,
    intervalSeconds: Number(map.get("lp_dividend_interval_seconds") ?? "604800"),
    lastAt: Number(map.get("lp_dividend_last_at") ?? "0"),
    round: Number(map.get("lp_dividend_round") ?? "0"),
  };
}

async function saveRoundMeta(env: Env, round: number, now: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('lp_dividend_last_at', ?, 'cron', ?)",
  )
    .bind(String(now), now)
    .run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('lp_dividend_round', ?, 'cron', ?)",
  )
    .bind(String(round), now)
    .run();
}

async function outUsers(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT user FROM burn_personal_status WHERE out_at IS NOT NULL")
    .all<{ user: string }>();
  return new Set((rows.results ?? []).map((r) => r.user.toLowerCase()));
}

/**
 * 分发 LP 交易分红：按管理员设定的固定 HS 税额，分给燃烧者。
 * - 70% 权重分红：所有燃烧者按个人 burn 占比分配
 * - 30% Top10：按 burn 排名前 10 按权重分配
 *
 * 写 reward_claims，走现有 burn claim 签名领取流程。
 * source_ref = lp-dividend:{round} 防重复分发。
 */
export async function distributeLpDividend(
  env: Env,
): Promise<{ round: number; amountHs: string; recipients: number; skipped: boolean }> {
  const cfg = await readConfig(env);
  const now = await nowSeconds(env);

  // 未到时间则跳过
  if (cfg.lastAt > 0 && now < cfg.lastAt + cfg.intervalSeconds) {
    return { round: cfg.round, amountHs: "0", recipients: 0, skipped: true };
  }

  const round = cfg.round + 1;
  const sourceRef = `lp-dividend:${round}`;

  // 防重复：已存在该 source_ref 则跳过
  const dup = await env.DB.prepare(
    "SELECT id FROM reward_claims WHERE source_ref = ? LIMIT 1",
  )
    .bind(sourceRef)
    .first<{ id: string }>();
  if (dup) return { round: cfg.round, amountHs: "0", recipients: 0, skipped: true };

  // 取所有燃烧记录，JS 侧 BigInt 聚合（避免 D1 SUM 对大数精度丢失）
  const rawRows = await env.DB.prepare(
    "SELECT user, hs_amount FROM burn_records",
  ).all<{ user: string; hs_amount: string }>();
  if (!rawRows.results || rawRows.results.length === 0) {
    return { round, amountHs: cfg.amountHs.toString(), recipients: 0, skipped: true };
  }

  // 按用户聚合
  const burnMap = new Map<string, bigint>();
  for (const r of rawRows.results) {
    const u = r.user.toLowerCase();
    burnMap.set(u, (burnMap.get(u) ?? 0n) + BigInt(r.hs_amount));
  }

  const out = await outUsers(env);
  const users: { user: string; burn: bigint }[] = [];
  let totalBurn = 0n;
  for (const [user, burn] of burnMap) {
    if (out.has(user) || burn <= 0n) continue;
    users.push({ user, burn });
    totalBurn += burn;
  }
  if (totalBurn <= 0n || users.length === 0) {
    return { round, amountHs: cfg.amountHs.toString(), recipients: 0, skipped: true };
  }

  const totalAmount = cfg.amountHs;
  const weightPool = (totalAmount * BigInt(BURN_LP_DIVIDEND_HOLDER_BPS)) / BigInt(BPS_DENOMINATOR);
  const top10Pool = (totalAmount * BigInt(BURN_LP_DIVIDEND_TOP10_BPS)) / BigInt(BPS_DENOMINATOR);

  let recipients = 0;

  // 70% 权重分红：每人按 burn 占比
  for (const u of users) {
    const reward = (weightPool * u.burn) / totalBurn;
    if (reward <= 0n) continue;
    await env.DB.prepare(
      `INSERT INTO reward_claims (id, user, kind, reward_token, reward_amount, round, source_ref, created_at)
       VALUES (?, ?, 'lp-dividend-weight', 'HS', ?, ?, ?, ?)`,
    )
      .bind(ulid(), u.user, reward.toString(), round, sourceRef, now)
      .run();
    recipients++;
  }

  // 30% Top10：按 burn 排名取前 10
  const top10 = [...users]
    .sort((a, b) => (a.burn === b.burn ? a.user.localeCompare(b.user) : a.burn > b.burn ? -1 : 1))
    .slice(0, 10);
  let totalTop10Burn = 0n;
  for (const u of top10) totalTop10Burn += u.burn;

  if (totalTop10Burn > 0n) {
    for (const u of top10) {
      const reward = (top10Pool * u.burn) / totalTop10Burn;
      if (reward <= 0n) continue;
      await env.DB.prepare(
        `INSERT INTO reward_claims (id, user, kind, reward_token, reward_amount, round, source_ref, created_at)
         VALUES (?, ?, 'lp-dividend-top10', 'HS', ?, ?, ?, ?)`,
      )
        .bind(ulid(), u.user, reward.toString(), round, sourceRef, now)
        .run();
      recipients++;
    }
  }

  // 保存轮次元数据
  await saveRoundMeta(env, round, now);

  return { round, amountHs: totalAmount.toString(), recipients, skipped: false };
}
