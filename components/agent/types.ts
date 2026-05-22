export interface AgentMe {
  address: string;
  isAgent: boolean;
  label: string | null;
  enabled: boolean;
}

export interface AgentFunds {
  stakeUsdt: string;
  aiPackageUsdt: string;
  stockUsdt: string;
  pendingUsdt: string;
  totalInUsdt: string;
  totalOutUsdt: string;
}

export interface AgentUser {
  address: string;
  generation: number;
  referrer: string | null;
  referralCode: string | null;
  joinedAt: number | null;
  lastActiveAt: number | null;
  funds: AgentFunds;
}

export interface AgentSummary {
  teamSize: number;
  totalInUsdt: string;
  totalOutUsdt: string;
  pendingUsdt: string;
  unreadAlerts: number;
}

export interface AgentAlert {
  id: string;
  user: string;
  type: string;
  label: string;
  direction: "deposit" | "withdraw" | "spend" | "credit";
  token: string;
  amount: string;
  usdtValue: string;
  occurredAt: number;
  unread: boolean;
  sourceRef?: string | null;
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