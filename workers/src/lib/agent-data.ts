import type { Env } from "../env";
import { nowSeconds } from "./time";
import { decimalToWei, hsWeiToUsdtWei, stakeAssetWeiToUsdtWei, stockWeiToUsdtWei } from "./pricing";
import type { StakeAsset } from "@/lib/constants/business-rules";

const SCALE = 10n ** 18n;
const DEFAULT_ALERT_THRESHOLD_USDT = 500;
let agentTablesEnsured = false;

export interface AgentAccount {
  address: string;
  label: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface AgentUserRow {
  address: string;
  generation: number;
  referrer: string | null;
  referralCode: string | null;
  joinedAt: number | null;
  lastActiveAt: number | null;
}

export interface UserFinancialSummary {
  stakeUsdt: string;
  aiPackageUsdt: string;
  stockUsdt: string;
  pendingUsdt: string;
  totalInUsdt: string;
  totalOutUsdt: string;
}

export interface AgentTransaction {
  id: string;
  user: string;
  type: string;
  label: string;
  direction: "deposit" | "withdraw" | "spend" | "credit";
  token: string;
  amount: string;
  usdtValue: string;
  occurredAt: number;
  status?: string;
  sourceRef?: string | null;
  extra?: Record<string, unknown>;
}

interface InternalTransaction extends AgentTransaction {
  usdtWei: bigint;
}

export interface AgentAlert {
  id: string;
  user: string;
  type: string;
  label: string;
  direction: AgentTransaction["direction"];
  token: string;
  amount: string;
  usdtValue: string;
  occurredAt: number;
  unread: boolean;
  sourceRef?: string | null;
}

type AgentPathRow = {
  user: string;
  level1: string | null;
  level2: string | null;
  level3: string | null;
  referrer: string | null;
  code: string | null;
  joined_at: number | null;
  last_active_at: number | null;
};

export function normalizeAddress(value: string | undefined | null): string | null {
  const address = value?.trim().toLowerCase();
  return address && /^0x[a-f0-9]{40}$/.test(address) ? address : null;
}

export function isAddress(value: string | undefined | null): value is string {
  return normalizeAddress(value) !== null;
}

export async function ensureAgentTables(env: Env): Promise<void> {
  if (agentTablesEnsured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS agent_accounts (
      address TEXT PRIMARY KEY,
      label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_agent_accounts_enabled ON agent_accounts(enabled)").run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS agent_alert_acknowledgements (
      agent_address TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      acknowledged_at INTEGER NOT NULL,
      PRIMARY KEY (agent_address, alert_id)
    )`,
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_agent_alert_ack_agent ON agent_alert_acknowledgements(agent_address, acknowledged_at)",
  ).run();
  agentTablesEnsured = true;
}

function parseWei(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

function formatWei(value: bigint, decimals = 2): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / SCALE;
  if (decimals <= 0) return `${sign}${whole.toString()}`;
  const fraction = (abs % SCALE).toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "");
  return fraction ? `${sign}${whole.toString()}.${fraction}` : `${sign}${whole.toString()}`;
}

function generationFor(row: Pick<AgentPathRow, "level1" | "level2" | "level3">, agent: string): number {
  if (row.level1 === agent) return 1;
  if (row.level2 === agent) return 2;
  if (row.level3 === agent) return 3;
  return 0;
}

function tokenAmountLabel(token: string, amount: string): string {
  return `${formatWei(parseWei(amount), 4)} ${token}`;
}

async function rewardTokenToUsdtWei(env: Env, token: string, amountWei: bigint): Promise<bigint> {
  if (amountWei <= 0n) return 0n;
  if (token === "USDT") return amountWei;
  if (token === "HS") return hsWeiToUsdtWei(env, amountWei);
  if (token === "STOCK") return stockWeiToUsdtWei(env, amountWei);
  return 0n;
}

async function claimTokenToUsdtWei(env: Env, token: string, amountWei: bigint): Promise<{ token: string; usdtWei: bigint }> {
  const normalized = token.toLowerCase();
  if (normalized === env.USDT_TOKEN.toLowerCase()) return { token: "USDT", usdtWei: amountWei };
  if (normalized === env.HS_TOKEN.toLowerCase()) return { token: "HS", usdtWei: await hsWeiToUsdtWei(env, amountWei) };
  return { token, usdtWei: 0n };
}

export async function readAgentAccount(env: Env, address: string): Promise<AgentAccount | null> {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  await ensureAgentTables(env);
  return await env.DB.prepare(
    "SELECT address, label, enabled, created_by, created_at, updated_at FROM agent_accounts WHERE address = ?",
  )
    .bind(normalized)
    .first<AgentAccount>();
}

export async function isEnabledAgent(env: Env, address: string): Promise<boolean> {
  const account = await readAgentAccount(env, address);
  return account?.enabled === 1;
}

export async function listAgentUsers(env: Env, agentAddress: string, q = ""): Promise<AgentUserRow[]> {
  const agent = normalizeAddress(agentAddress);
  if (!agent) return [];
  const rs = await env.DB.prepare(
    `SELECT rp.user, rp.level1, rp.level2, rp.level3, u.referrer, u.joined_at, u.last_active_at, rc.code
       FROM referral_paths rp
       LEFT JOIN users u ON u.address = rp.user
       LEFT JOIN referral_codes rc ON rc.user = rp.user
      WHERE rp.level1 = ? OR rp.level2 = ? OR rp.level3 = ?`,
  )
    .bind(agent, agent, agent)
    .all<AgentPathRow>();

  const needle = q.trim().toLowerCase();
  return (rs.results ?? [])
    .map((row) => ({
      address: row.user,
      generation: generationFor(row, agent),
      referrer: row.referrer,
      referralCode: row.code,
      joinedAt: row.joined_at,
      lastActiveAt: row.last_active_at,
    }))
    .filter((row) => {
      if (!needle) return true;
      return (
        row.address.toLowerCase().includes(needle) ||
        row.referrer?.toLowerCase().includes(needle) ||
        row.referralCode?.toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => (b.joinedAt ?? 0) - (a.joinedAt ?? 0));
}

export async function getAgentUser(env: Env, agentAddress: string, userAddress: string): Promise<AgentUserRow | null> {
  const user = normalizeAddress(userAddress);
  if (!user) return null;
  const users = await listAgentUsers(env, agentAddress);
  return users.find((row) => row.address === user) ?? null;
}

export async function getUserFinancialSummary(env: Env, userAddress: string): Promise<UserFinancialSummary> {
  const user = normalizeAddress(userAddress);
  if (!user) {
    return { stakeUsdt: "0", aiPackageUsdt: "0", stockUsdt: "0", pendingUsdt: "0", totalInUsdt: "0", totalOutUsdt: "0" };
  }
  const now = await nowSeconds(env);
  let stakeUsdtWei = 0n;
  let stakeDepositUsdtWei = 0n;
  let pendingUsdtWei = 0n;

  const stakeRows = await env.DB.prepare(
    "SELECT asset, amount, lock_months, monthly_rate_bps, matures_at, claimed FROM stake_orders WHERE user = ?",
  )
    .bind(user)
    .all<{ asset: string; amount: string; lock_months: number; monthly_rate_bps: number; matures_at: number; claimed: number }>();
  for (const row of stakeRows.results ?? []) {
    const principal = await stakeAssetWeiToUsdtWei(env, row.asset as StakeAsset, parseWei(row.amount));
    stakeDepositUsdtWei += principal;
    if (!row.claimed) stakeUsdtWei += principal;
    if (!row.claimed && row.matures_at <= now) {
      const grossYield = (principal * BigInt(row.monthly_rate_bps) * BigInt(row.lock_months)) / 10_000n;
      pendingUsdtWei += (grossYield * 9_500n) / 10_000n;
    }
  }

  const aiRows = await env.DB.prepare("SELECT usdt_in FROM ai_orders WHERE user = ?")
    .bind(user)
    .all<{ usdt_in: string }>();
  let aiPackageUsdtWei = 0n;
  for (const row of aiRows.results ?? []) aiPackageUsdtWei += parseWei(row.usdt_in);

  const stockRow = await env.DB.prepare("SELECT total_stock FROM stock_holdings WHERE user = ?")
    .bind(user)
    .first<{ total_stock: string }>();
  const stockUsdtWei = await stockWeiToUsdtWei(env, parseWei(stockRow?.total_stock));

  const lotteryRows = await env.DB.prepare(
    "SELECT prize_hs FROM lottery_tickets WHERE user = ? AND claimed = 0 AND prize_hs IS NOT NULL",
  )
    .bind(user)
    .all<{ prize_hs: string }>();
  for (const row of lotteryRows.results ?? []) pendingUsdtWei += await hsWeiToUsdtWei(env, parseWei(row.prize_hs));

  const dividendRows = await env.DB.prepare("SELECT stock_share FROM ai_dividend_user_daily WHERE user = ? AND claimed = 0")
    .bind(user)
    .all<{ stock_share: string }>();
  for (const row of dividendRows.results ?? []) pendingUsdtWei += await stockWeiToUsdtWei(env, parseWei(row.stock_share));

  const burnRows = await env.DB.prepare("SELECT reward_hs FROM burn_top10_settlements WHERE user = ? AND claimed = 0")
    .bind(user)
    .all<{ reward_hs: string }>();
  for (const row of burnRows.results ?? []) pendingUsdtWei += await hsWeiToUsdtWei(env, parseWei(row.reward_hs));

  const rewardRows = await env.DB.prepare(
    `SELECT reward_token, reward_amount FROM referral_rewards WHERE user = ? AND claimed = 0
     UNION ALL
     SELECT reward_token, reward_amount FROM reward_claims WHERE user = ? AND claimed = 0`,
  )
    .bind(user, user)
    .all<{ reward_token: string; reward_amount: string }>();
  for (const row of rewardRows.results ?? []) {
    pendingUsdtWei += await rewardTokenToUsdtWei(env, row.reward_token, parseWei(row.reward_amount));
  }

  const claimRows = await env.DB.prepare("SELECT token, amount FROM claim_signatures WHERE user = ?")
    .bind(user)
    .all<{ token: string; amount: string }>();
  let totalOutUsdtWei = 0n;
  for (const row of claimRows.results ?? []) {
    totalOutUsdtWei += (await claimTokenToUsdtWei(env, row.token, parseWei(row.amount))).usdtWei;
  }

  return {
    stakeUsdt: formatWei(stakeUsdtWei),
    aiPackageUsdt: formatWei(aiPackageUsdtWei),
    stockUsdt: formatWei(stockUsdtWei),
    pendingUsdt: formatWei(pendingUsdtWei),
    totalInUsdt: formatWei(stakeDepositUsdtWei + aiPackageUsdtWei),
    totalOutUsdt: formatWei(totalOutUsdtWei),
  };
}

function serializeTransaction(tx: InternalTransaction): AgentTransaction {
  const { usdtWei, ...rest } = tx;
  return { ...rest, usdtValue: formatWei(usdtWei) };
}

export async function listUserTransactions(env: Env, userAddress: string): Promise<AgentTransaction[]> {
  return (await listInternalUserTransactions(env, userAddress)).map(serializeTransaction);
}

async function listInternalUserTransactions(env: Env, userAddress: string): Promise<InternalTransaction[]> {
  const user = normalizeAddress(userAddress);
  if (!user) return [];
  const txs: InternalTransaction[] = [];

  const aiRows = await env.DB.prepare("SELECT id, tier, usdt_in, stock_granted, created_at, source_tx_hash FROM ai_orders WHERE user = ?")
    .bind(user)
    .all<{ id: string; tier: string; usdt_in: string; stock_granted: string; created_at: number; source_tx_hash: string }>();
  for (const row of aiRows.results ?? []) {
    txs.push({
      id: `ai_order:${row.id}`,
      user,
      type: "ai_order",
      label: "AI 套餐购买",
      direction: "deposit",
      token: "USDT",
      amount: tokenAmountLabel("USDT", row.usdt_in),
      usdtValue: "0",
      usdtWei: parseWei(row.usdt_in),
      occurredAt: row.created_at,
      sourceRef: row.source_tx_hash,
      extra: { tier: row.tier, stockGranted: tokenAmountLabel("WTO", row.stock_granted) },
    });
  }

  const stakeRows = await env.DB.prepare(
    "SELECT id, asset, amount, lock_months, claimed, started_at, source_tx_hash FROM stake_orders WHERE user = ?",
  )
    .bind(user)
    .all<{ id: string; asset: string; amount: string; lock_months: number; claimed: number; started_at: number; source_tx_hash: string }>();
  for (const row of stakeRows.results ?? []) {
    const amountWei = parseWei(row.amount);
    txs.push({
      id: `stake:${row.id}`,
      user,
      type: "stake",
      label: "质押入金",
      direction: "deposit",
      token: row.asset,
      amount: tokenAmountLabel(row.asset, row.amount),
      usdtValue: "0",
      usdtWei: await stakeAssetWeiToUsdtWei(env, row.asset as StakeAsset, amountWei),
      occurredAt: row.started_at,
      status: row.claimed ? "claimed" : "active",
      sourceRef: row.source_tx_hash,
      extra: { lockMonths: row.lock_months },
    });
  }

  const lotteryRows = await env.DB.prepare(
    "SELECT id, round_no, paid_hs, bought_at, source_tx_hash FROM lottery_tickets WHERE user = ?",
  )
    .bind(user)
    .all<{ id: string; round_no: number; paid_hs: string; bought_at: number; source_tx_hash: string }>();
  for (const row of lotteryRows.results ?? []) {
    txs.push({
      id: `lottery:${row.id}`,
      user,
      type: "lottery",
      label: "彩票购买",
      direction: "spend",
      token: "HS",
      amount: tokenAmountLabel("HS", row.paid_hs),
      usdtValue: "0",
      usdtWei: await hsWeiToUsdtWei(env, parseWei(row.paid_hs)),
      occurredAt: row.bought_at,
      sourceRef: row.source_tx_hash,
      extra: { roundNo: row.round_no },
    });
  }

  const burnRows = await env.DB.prepare("SELECT id, hs_amount, burned_at, source_tx_hash FROM burn_records WHERE user = ?")
    .bind(user)
    .all<{ id: string; hs_amount: string; burned_at: number; source_tx_hash: string }>();
  for (const row of burnRows.results ?? []) {
    txs.push({
      id: `burn:${row.id}`,
      user,
      type: "burn",
      label: "燃烧消耗",
      direction: "spend",
      token: "HS",
      amount: tokenAmountLabel("HS", row.hs_amount),
      usdtValue: "0",
      usdtWei: await hsWeiToUsdtWei(env, parseWei(row.hs_amount)),
      occurredAt: row.burned_at,
      sourceRef: row.source_tx_hash,
    });
  }

  const swapRows = await env.DB.prepare("SELECT id, hs_in, stock_out, swapped_at, source_tx_hash FROM stock_swaps WHERE user = ?")
    .bind(user)
    .all<{ id: string; hs_in: string; stock_out: string; swapped_at: number; source_tx_hash: string }>();
  for (const row of swapRows.results ?? []) {
    txs.push({
      id: `swap:${row.id}`,
      user,
      type: "swap",
      label: "HS 闪兑股票",
      direction: "spend",
      token: "HS",
      amount: tokenAmountLabel("HS", row.hs_in),
      usdtValue: "0",
      usdtWei: await hsWeiToUsdtWei(env, parseWei(row.hs_in)),
      occurredAt: row.swapped_at,
      sourceRef: row.source_tx_hash,
      extra: { stockOut: tokenAmountLabel("WTO", row.stock_out) },
    });
  }

  const claimRows = await env.DB.prepare("SELECT nonce, token, amount, used_at, created_at FROM claim_signatures WHERE user = ?")
    .bind(user)
    .all<{ nonce: string; token: string; amount: string; used_at: number | null; created_at: number }>();
  for (const row of claimRows.results ?? []) {
    const converted = await claimTokenToUsdtWei(env, row.token, parseWei(row.amount));
    txs.push({
      id: `claim:${row.nonce}`,
      user,
      type: "claim",
      label: "链上领取出金",
      direction: "withdraw",
      token: converted.token,
      amount: tokenAmountLabel(converted.token, row.amount),
      usdtValue: "0",
      usdtWei: converted.usdtWei,
      occurredAt: row.used_at ?? row.created_at,
      status: row.used_at ? "used" : "pending",
      sourceRef: row.nonce,
    });
  }

  const dividendRows = await env.DB.prepare("SELECT date, stock_share, claimed FROM ai_dividend_user_daily WHERE user = ?")
    .bind(user)
    .all<{ date: string; stock_share: string; claimed: number }>();
  for (const row of dividendRows.results ?? []) {
    txs.push({
      id: `stock_dividend:${row.date}:${user}`,
      user,
      type: "stock_dividend",
      label: "股票分红入账",
      direction: "credit",
      token: "WTO",
      amount: tokenAmountLabel("WTO", row.stock_share),
      usdtValue: "0",
      usdtWei: await stockWeiToUsdtWei(env, parseWei(row.stock_share)),
      occurredAt: Date.parse(`${row.date}T00:00:00Z`) / 1000 || 0,
      status: row.claimed ? "claimed" : "pending",
    });
  }

  return txs.sort((a, b) => b.occurredAt - a.occurredAt);
}

export async function getAgentSummary(env: Env, agentAddress: string): Promise<{
  teamSize: number;
  totalInUsdt: string;
  totalOutUsdt: string;
  pendingUsdt: string;
  unreadAlerts: number;
}> {
  const users = await listAgentUsers(env, agentAddress);
  let totalIn = 0n;
  let totalOut = 0n;
  let pending = 0n;
  for (const user of users) {
    const summary = await getUserFinancialSummary(env, user.address);
    totalIn += decimalToWei(Number(summary.totalInUsdt));
    totalOut += decimalToWei(Number(summary.totalOutUsdt));
    pending += decimalToWei(Number(summary.pendingUsdt));
  }
  const alerts = await listAgentAlerts(env, agentAddress, DEFAULT_ALERT_THRESHOLD_USDT, true);
  return {
    teamSize: users.length,
    totalInUsdt: formatWei(totalIn),
    totalOutUsdt: formatWei(totalOut),
    pendingUsdt: formatWei(pending),
    unreadAlerts: alerts.length,
  };
}

export async function listAgentAlerts(
  env: Env,
  agentAddress: string,
  thresholdUsdt = DEFAULT_ALERT_THRESHOLD_USDT,
  unreadOnly = false,
): Promise<AgentAlert[]> {
  const agent = normalizeAddress(agentAddress);
  if (!agent) return [];
  await ensureAgentTables(env);
  const users = await listAgentUsers(env, agent);
  const thresholdWei = decimalToWei(thresholdUsdt);
  const ackRows = await env.DB.prepare("SELECT alert_id FROM agent_alert_acknowledgements WHERE agent_address = ?")
    .bind(agent)
    .all<{ alert_id: string }>();
  const acknowledged = new Set((ackRows.results ?? []).map((row) => row.alert_id));
  const alerts: AgentAlert[] = [];
  for (const user of users) {
    const txs = await listInternalUserTransactions(env, user.address);
    for (const tx of txs) {
      if (!["deposit", "withdraw", "spend"].includes(tx.direction)) continue;
      if (tx.usdtWei < thresholdWei) continue;
      const unread = !acknowledged.has(tx.id);
      if (unreadOnly && !unread) continue;
      alerts.push({
        id: tx.id,
        user: tx.user,
        type: tx.type,
        label: tx.label,
        direction: tx.direction,
        token: tx.token,
        amount: tx.amount,
        usdtValue: formatWei(tx.usdtWei),
        occurredAt: tx.occurredAt,
        unread,
        sourceRef: tx.sourceRef,
      });
    }
  }
  return alerts.sort((a, b) => b.occurredAt - a.occurredAt);
}

export async function acknowledgeAgentAlerts(env: Env, agentAddress: string, alertIds: string[]): Promise<number> {
  const agent = normalizeAddress(agentAddress);
  if (!agent) return 0;
  await ensureAgentTables(env);
  const now = await nowSeconds(env);
  let acknowledged = 0;
  for (const alertId of new Set(alertIds.filter(Boolean))) {
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO agent_alert_acknowledgements (agent_address, alert_id, acknowledged_at) VALUES (?, ?, ?)",
    )
      .bind(agent, alertId, now)
      .run();
    acknowledged += result.meta?.changes ?? 0;
  }
  return acknowledged;
}