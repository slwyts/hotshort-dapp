import type { Env } from "../env";
import { nowSeconds } from "./time";
import { addRewardClaim } from "./reward-claims";
import {
  BURN_LP_DIVIDEND_HOLDER_BPS,
  BURN_LP_DIVIDEND_TOP10_BPS,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

interface LpDividendConfig {
  thresholdUsdt: bigint;
  lastAt: number;
  round: number;
}

interface LpTaxReceiptRow {
  id: string;
  amount_usdt: string;
}

function decimalToWeiString(value: string): bigint {
  const text = value.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(text)) return 0n;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}

async function readConfig(env: Env): Promise<LpDividendConfig> {
  const keys = ["lp_dividend_threshold_usdt", "lp_dividend_last_at", "lp_dividend_round"];
  const rows = await env.DB.prepare(
    `SELECT key, value FROM admin_config WHERE key IN (${keys.map(() => "?").join(",")})`,
  )
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const map = new Map<string, string>();
  for (const row of rows.results ?? []) map.set(row.key, row.value);

  return {
    thresholdUsdt: decimalToWeiString(map.get("lp_dividend_threshold_usdt") ?? "100"),
    lastAt: Number(map.get("lp_dividend_last_at") ?? "0"),
    round: Number(map.get("lp_dividend_round") ?? "0"),
  };
}

async function saveRoundMeta(env: Env, round: number, now: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('lp_dividend_last_at', ?, 'lp-dividend', ?)",
  )
    .bind(String(now), now)
    .run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES ('lp_dividend_round', ?, 'lp-dividend', ?)",
  )
    .bind(String(round), now)
    .run();
}

async function outUsers(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT user FROM burn_personal_status WHERE out_at IS NOT NULL")
    .all<{ user: string }>();
  return new Set((rows.results ?? []).map((row) => row.user.toLowerCase()));
}

async function pendingReceipts(env: Env): Promise<{ rows: LpTaxReceiptRow[]; total: bigint }> {
  const rows = await env.DB.prepare(
    `SELECT id, amount_usdt FROM lp_tax_receipts
      WHERE settled_round IS NULL
      ORDER BY received_at ASC, tx_hash ASC, log_index ASC`,
  ).all<LpTaxReceiptRow>();
  let total = 0n;
  for (const row of rows.results ?? []) total += BigInt(row.amount_usdt);
  return { rows: rows.results ?? [], total };
}

export async function distributeLpDividend(
  env: Env,
  options: { force?: boolean } = {},
): Promise<{
  round: number;
  amountUsdt: string;
  thresholdUsdt: string;
  recipients: number;
  skipped: boolean;
  pendingUsdt: string;
}> {
  const cfg = await readConfig(env);
  const now = await nowSeconds(env);
  const pending = await pendingReceipts(env);

  if (pending.total <= 0n) {
    return {
      round: cfg.round,
      amountUsdt: "0",
      thresholdUsdt: cfg.thresholdUsdt.toString(),
      recipients: 0,
      skipped: true,
      pendingUsdt: "0",
    };
  }
  if (!options.force && cfg.thresholdUsdt > 0n && pending.total < cfg.thresholdUsdt) {
    return {
      round: cfg.round,
      amountUsdt: "0",
      thresholdUsdt: cfg.thresholdUsdt.toString(),
      recipients: 0,
      skipped: true,
      pendingUsdt: pending.total.toString(),
    };
  }

  const round = cfg.round + 1;
  const sourceRef = `lp-dividend:${round}`;
  const duplicate = await env.DB.prepare("SELECT id FROM reward_claims WHERE source_ref = ? LIMIT 1")
    .bind(sourceRef)
    .first<{ id: string }>();
  if (duplicate) {
    return {
      round: cfg.round,
      amountUsdt: "0",
      thresholdUsdt: cfg.thresholdUsdt.toString(),
      recipients: 0,
      skipped: true,
      pendingUsdt: pending.total.toString(),
    };
  }

  const rawRows = await env.DB.prepare("SELECT user, hs_amount FROM burn_records")
    .all<{ user: string; hs_amount: string }>();
  const burnMap = new Map<string, bigint>();
  for (const row of rawRows.results ?? []) {
    const user = row.user.toLowerCase();
    burnMap.set(user, (burnMap.get(user) ?? 0n) + BigInt(row.hs_amount));
  }

  const out = await outUsers(env);
  const users: { user: string; burn: bigint }[] = [];
  let totalBurn = 0n;
  for (const [user, burn] of burnMap) {
    if (out.has(user) || burn <= 0n) continue;
    users.push({ user, burn });
    totalBurn += burn;
  }
  if (users.length === 0 || totalBurn <= 0n) {
    return {
      round: cfg.round,
      amountUsdt: "0",
      thresholdUsdt: cfg.thresholdUsdt.toString(),
      recipients: 0,
      skipped: true,
      pendingUsdt: pending.total.toString(),
    };
  }

  const weightPool = (pending.total * BigInt(BURN_LP_DIVIDEND_HOLDER_BPS)) / BigInt(BPS_DENOMINATOR);
  const top10Pool = (pending.total * BigInt(BURN_LP_DIVIDEND_TOP10_BPS)) / BigInt(BPS_DENOMINATOR);
  let recipients = 0;

  for (const user of users) {
    const reward = (weightPool * user.burn) / totalBurn;
    if (reward <= 0n) continue;
    await addRewardClaim(env, {
      user: user.user,
      kind: "lp-dividend-weight",
      token: "USDT",
      amount: reward,
      round,
      sourceRef,
      now,
    });
    recipients++;
  }

  const top10 = [...users]
    .sort((a, b) => (a.burn === b.burn ? a.user.localeCompare(b.user) : a.burn > b.burn ? -1 : 1))
    .slice(0, 10);
  let totalTop10Burn = 0n;
  for (const user of top10) totalTop10Burn += user.burn;

  if (totalTop10Burn > 0n) {
    for (const user of top10) {
      const reward = (top10Pool * user.burn) / totalTop10Burn;
      if (reward <= 0n) continue;
      await addRewardClaim(env, {
        user: user.user,
        kind: "lp-dividend-top10",
        token: "USDT",
        amount: reward,
        round,
        sourceRef,
        now,
      });
      recipients++;
    }
  }

  for (const receipt of pending.rows) {
    await env.DB.prepare("UPDATE lp_tax_receipts SET settled_round = ? WHERE id = ? AND settled_round IS NULL")
      .bind(round, receipt.id)
      .run();
  }
  await saveRoundMeta(env, round, now);

  return {
    round,
    amountUsdt: pending.total.toString(),
    thresholdUsdt: cfg.thresholdUsdt.toString(),
    recipients,
    skipped: false,
    pendingUsdt: "0",
  };
}
