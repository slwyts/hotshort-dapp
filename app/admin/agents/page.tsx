"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { Loader2, Users, ChevronLeft } from "lucide-react";
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
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Users className="h-6 w-6 text-[#00c6ff]" /> 代理商
        </h1>
        <p className="mt-1 text-sm text-white/50">
          团队数据与返佣统计
        </p>

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
