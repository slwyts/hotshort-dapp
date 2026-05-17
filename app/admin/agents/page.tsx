"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { Loader2, Users } from "lucide-react";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function AdminAgentsPage() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<{ agents: AgentRow[] }>(
        `${endpoints.adminAgents}${keyword ? `?q=${encodeURIComponent(keyword)}` : ""}`,
        token,
      );
      setRows(r.agents ?? []);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, keyword, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Users className="h-6 w-6 text-[#00c6ff]" /> 代理商及统计
        </h1>
        <p className="mt-1 text-sm text-white/50">
          按团队规模 / 累计返佣排序的 Top 代理商。按地址或 tier 筛选。
        </p>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>代理商榜单</CardTitle>
            <CardDescription>三代下线团队规模 + 累计返佣（含 AI 直推 + 三代股票分红 + 燃烧推广）</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex gap-2">
              <Input
                placeholder="按地址 / tier 搜索..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void refresh();
                }}
                className="max-w-sm"
              />
              <Button variant="outline" onClick={() => void refresh()}>
                搜索
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
                    <tr className="border-b border-white/10 text-left text-xs uppercase text-white/40">
                      <th className="px-2 py-2">地址</th>
                      <th className="px-2 py-2">最高档</th>
                      <th className="px-2 py-2 text-right">三代团队</th>
                      <th className="px-2 py-2 text-right">套餐数</th>
                      <th className="px-2 py-2 text-right">累计投入</th>
                      <th className="px-2 py-2 text-right">累计返佣</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.address} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="px-2 py-2 font-mono text-xs text-white/70">
                          {shortenAddress(r.address, 6)}
                        </td>
                        <td className="px-2 py-2 text-[#b829ff]">{r.tier}</td>
                        <td className="px-2 py-2 text-right">{r.team_size.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right">{r.ai_orders_count}</td>
                        <td className="px-2 py-2 text-right text-white/80">
                          {formatNumber(Number(r.ai_orders_usdt) / 1e18, 0)}
                        </td>
                        <td className="px-2 py-2 text-right text-[#00c6ff]">
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
