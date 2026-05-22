"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { Loader2, Users, ChevronLeft, Power, PowerOff, Plus, RefreshCw } from "lucide-react";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { shortenAddress, formatNumber } from "@/lib/utils";

interface AgentRow {
  address: string;
  tier: string;
  team_size: number;
  ai_orders_count: number;
  ai_orders_usdt: string;
  referral_rewards_usdt: string;
}

interface AgentAccountRow {
  address: string;
  label: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  teamSize: number;
  unreadAlerts: number;
}

const TIER_LABELS: Record<string, string> = {
  genesis: "创世",
  glory: "荣耀",
  eternal: "永恒",
  shine: "鑫耀",
  pioneer: "开拓者",
};

export default function AdminAgentsPage() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [accounts, setAccounts] = useState<AgentAccountRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [agentAddress, setAgentAddress] = useState("");
  const [agentLabel, setAgentLabel] = useState("");

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const [stats, accountResp] = await Promise.all([
        api.get<{ agents: AgentRow[] }>(
          `${endpoints.adminAgents}${keyword ? `?q=${encodeURIComponent(keyword)}` : ""}`,
          token,
        ),
        api.get<{ accounts: AgentAccountRow[] }>(endpoints.adminAgentAccounts, token),
      ]);
      setRows(stats.agents ?? []);
      setAccounts(accountResp.accounts ?? []);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, keyword, signIn]);

  const addAccount = async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSaving(true);
    try {
      await api.post(endpoints.adminAgentAccounts, { address: agentAddress, label: agentLabel }, token);
      setAgentAddress("");
      setAgentLabel("");
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const toggleAccount = async (account: AgentAccountRow) => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSaving(true);
    try {
      await api.patch(`${endpoints.adminAgentAccounts}/${account.address}`, { enabled: account.enabled !== 1 }, token);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Users className="h-6 w-6 text-[#00c6ff]" /> 代理商
        </h1>
        <p className="mt-1 text-sm text-white/50">
          团队数据、返佣统计与代理后台授权
        </p>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>代理后台授权</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
              <Input
                placeholder="代理钱包地址 0x..."
                value={agentAddress}
                onChange={(e) => setAgentAddress(e.target.value)}
              />
              <Input
                placeholder="备注，例如 华南代理"
                value={agentLabel}
                onChange={(e) => setAgentLabel(e.target.value)}
              />
              <Button onClick={() => void addAccount()} disabled={saving || !agentAddress.trim()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                授权代理
              </Button>
            </div>

            <div className="mt-5 overflow-x-auto">
              {accounts.length === 0 ? (
                <div className="rounded-lg border border-white/5 bg-white/[0.02] py-8 text-center text-sm text-white/40">暂无授权代理</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-white/40">
                      <th className="px-3 py-3">代理钱包</th>
                      <th className="px-3 py-3">备注</th>
                      <th className="px-3 py-3 text-right">旗下用户</th>
                      <th className="px-3 py-3 text-right">未读预警</th>
                      <th className="px-3 py-3 text-right">状态</th>
                      <th className="px-3 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => (
                      <tr key={account.address} className="border-b border-white/5 hover:bg-white/[0.03]">
                        <td className="px-3 py-3 font-mono text-xs text-white/75">{shortenAddress(account.address, 6)}</td>
                        <td className="px-3 py-3 text-white/65">{account.label ?? "-"}</td>
                        <td className="px-3 py-3 text-right">{account.teamSize.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-amber-300">{account.unreadAlerts}</td>
                        <td className="px-3 py-3 text-right">
                          <span className={`rounded border px-2 py-1 text-xs ${account.enabled === 1 ? "border-green-400/25 bg-green-400/10 text-green-300" : "border-white/10 bg-white/5 text-white/40"}`}>
                            {account.enabled === 1 ? "已启用" : "已停用"}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Button size="sm" variant="outline" onClick={() => void toggleAccount(account)} disabled={saving}>
                            {account.enabled === 1 ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                            {account.enabled === 1 ? "停用" : "启用"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>代理商列表</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex gap-2">
              <Input
                placeholder="搜索地址或等级..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void refresh();
                }}
                className="max-w-sm"
              />
              <Button variant="outline" onClick={() => void refresh()}>
                <RefreshCw className="h-4 w-4" /> 搜索
              </Button>
            </div>

            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : rows.length === 0 ? (
              <div className="py-8 text-center text-sm text-white/40">暂无数据</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-white/40">
                      <th className="px-3 py-3">地址</th>
                      <th className="px-3 py-3">等级</th>
                      <th className="px-3 py-3 text-right">团队人数</th>
                      <th className="px-3 py-3 text-right">套餐订单</th>
                      <th className="px-3 py-3 text-right">累计投入 (USDT)</th>
                      <th className="px-3 py-3 text-right">累计返佣 (USDT)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.address} className={`border-b border-white/5 ${i % 2 === 0 ? "bg-white/[0.01]" : ""} hover:bg-white/[0.03]`}>
                        <td className="px-3 py-3 font-mono text-xs text-white/70">
                          {shortenAddress(r.address, 6)}
                        </td>
                        <td className="px-3 py-3 text-[#b829ff] font-medium">{TIER_LABELS[r.tier] ?? r.tier}</td>
                        <td className="px-3 py-3 text-right">{r.team_size.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">{r.ai_orders_count}</td>
                        <td className="px-3 py-3 text-right text-white/80">
                          {formatNumber(Number(r.ai_orders_usdt) / 1e18, 0)}
                        </td>
                        <td className="px-3 py-3 text-right text-[#00c6ff] font-medium">
                          {formatNumber(Number(r.referral_rewards_usdt) / 1e18, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}
