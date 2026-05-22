/**
 * Worker API 客户端封装。
 * Worker URL 通过 NEXT_PUBLIC_WORKER_URL 配置。
 */

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL || "";

export class ApiError extends Error {
  status: number;
  payload?: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  jwt?: string,
): Promise<T> {
  if (!WORKER_URL) {
    throw new ApiError(0, "NEXT_PUBLIC_WORKER_URL 未配置");
  }
  const url = `${WORKER_URL.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (jwt) headers.set("authorization", `Bearer ${jwt}`);

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error || res.statusText || "request failed";
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, jwt?: string) => request<T>(path, { method: "GET" }, jwt),
  post: <T>(path: string, body?: unknown, jwt?: string) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }, jwt),
  patch: <T>(path: string, body?: unknown, jwt?: string) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }, jwt),
  delete: <T>(path: string, jwt?: string) => request<T>(path, { method: "DELETE" }, jwt),
};

export const endpoints = {
  health: "/health",
  hsPrice: "/oracle/hs-price",
  stockPrice: "/oracle/stock-price",
  portfolio: "/portfolio",
  siweNonce: "/auth/nonce",
  siweVerify: "/auth/verify",
  stakeRates: "/stake/rates",
  stakeOrders: "/stake/orders",
  stakeClaim: "/stake/claim",
  aiBuy: "/ai/buy",
  aiOrders: "/ai/orders",
  aiHoldings: "/ai/holdings",
  aiSwap: "/ai/swap",
  aiDividendToday: "/ai/dividend/today",
  aiDividendClaim: "/ai/dividend/claim",
  aiReferralClaim: "/ai/referral/claim",
  aiAirdropClaim: "/ai/airdrop/claim",
  lotteryRound: "/lottery/round",
  lotteryBuy: "/lottery/buy",
  lotteryClaim: "/lottery/claim",
  burnRecord: "/burn/record",
  burnLeaderboard: "/burn/leaderboard",
  burnRound: "/burn/round",
  burnRecords: "/burn/records",
  burnClaim: "/burn/claim/top10",
  referralTree: "/referral/tree",
  referralBind: "/referral/bind",
  referralMe: "/referral/me",
  referralOwner: "/referral/owner",
  referralCode: "/referral/code",
  referralResolve: (code: string) => `/referral/resolve/${encodeURIComponent(code)}`,
  adminRates: "/admin/rates",
  adminLottery: "/admin/lottery-config",
  adminGenesisImport: "/admin/genesis-import",
  adminGenesisScan: "/admin/genesis-scan",
  adminAirdrop: "/admin/airdrop-list",
  adminAgents: "/admin/agents",
  adminAgentAccounts: "/admin/agent-accounts",
  adminStockPrice: "/admin/stock-price",
  adminStockPriceMode: "/admin/stock-price/mode",
  adminStockPriceSync: "/admin/stock-price/sync",
  adminAiConfig: "/admin/ai-config",
  agentMe: "/agent/me",
  agentSummary: "/agent/summary",
  agentUsers: "/agent/users",
  agentUserDetail: (address: string) => `/agent/users/${encodeURIComponent(address)}`,
  agentUserTransactions: (address: string) => `/agent/users/${encodeURIComponent(address)}/transactions`,
  agentAlerts: "/agent/alerts",
  agentAlertAck: "/agent/alerts/ack",
} as const;
