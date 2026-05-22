"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import Swal from "sweetalert2";
import { AlertTriangle, ArrowRight, Bell, Loader2, TrendingDown, TrendingUp, Users, WalletCards } from "lucide-react";
import { AgentGuard } from "@/components/agent-guard";
import { AgentShell } from "@/components/agent/agent-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { formatNumber, shortenAddress } from "@/lib/utils";
import type { AgentAlert, AgentSummary } from "@/components/agent/types";

function StatCard({ title, value, icon: Icon }: { title: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-5">
        <div>
          <div className="text-xs text-white/45">{title}</div>
          <div className="mt-1 text-xl font-black text-white">{value}</div>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5">
          <Icon className="h-5 w-5 text-[#00c6ff]" />
        </div>
      </CardContent>
    </Card>
  );
}

function AgentOverview() {
  const { address } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const router = useRouter();
  const [summary, setSummary] = useState<AgentSummary | null>(null);
  const [alerts, setAlerts] = useState<AgentAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const [summaryResp, unreadResp] = await Promise.all([
        api.get<AgentSummary>(endpoints.agentSummary, token),
        api.get<{ items: AgentAlert[] }>(`${endpoints.agentAlerts}?unreadOnly=1`, token),
      ]);
      setSummary(summaryResp);
      setAlerts(unreadResp.items ?? []);
      const popupKey = `hotshort_agent_alert_popup_${address ?? ""}_${(unreadResp.items ?? []).map((item) => item.id).join("|")}`;
      if ((unreadResp.items ?? []).length > 0 && !sessionStorage.getItem(popupKey)) {
        sessionStorage.setItem(popupKey, "1");
        const result = await Swal.fire({
          icon: "warning",
          title: "存在未读大额交易预警",
          text: `当前有 ${(unreadResp.items ?? []).length} 条未读预警。`,
          confirmButtonText: "去预警页查看",
          showCancelButton: true,
          cancelButtonText: "稍后查看",
          background: "#141419",
          color: "#fff",
        });
        if (result.isConfirmed) router.push("/agent/alerts");
      }
    } finally {
      setLoading(false);
    }
  }, [address, jwt, router, signIn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loader2 className="mx-auto mt-12 h-6 w-6 animate-spin text-white/40" />;

  return (
    <AgentShell>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard title="旗下用户" value={String(summary?.teamSize ?? 0)} icon={Users} />
        <StatCard title="总入金 U" value={formatNumber(Number(summary?.totalInUsdt ?? 0), 2)} icon={TrendingUp} />
        <StatCard title="总出金 U" value={formatNumber(Number(summary?.totalOutUsdt ?? 0), 2)} icon={TrendingDown} />
        <StatCard title="待领折合 U" value={formatNumber(Number(summary?.pendingUsdt ?? 0), 2)} icon={WalletCards} />
        <StatCard title="未读预警" value={String(summary?.unreadAlerts ?? 0)} icon={Bell} />
      </div>

      <Card className="mt-5">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-300" /> 最近未读预警</CardTitle>
          <Link href="/agent/alerts" className="inline-flex items-center gap-1 text-sm text-[#00c6ff] hover:text-white">
            查看全部 <ArrowRight className="h-4 w-4" />
          </Link>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <div className="py-8 text-center text-sm text-white/40">暂无未读预警</div>
          ) : (
            <div className="divide-y divide-white/5">
              {alerts.slice(0, 6).map((item) => (
                <Link key={item.id} href={`/agent/users/${item.user}`} className="flex items-center justify-between gap-4 py-3 text-sm hover:bg-white/[0.02]">
                  <div className="min-w-0">
                    <div className="font-medium text-white">{item.label}</div>
                    <div className="mt-1 font-mono text-xs text-white/45">{shortenAddress(item.user, 6)} · {item.amount}</div>
                  </div>
                  <div className="text-right text-amber-300">${formatNumber(Number(item.usdtValue), 2)}</div>
                </Link>
              ))}
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <Button variant="outline" onClick={() => router.push("/agent/users")}>查看用户列表</Button>
          </div>
        </CardContent>
      </Card>
    </AgentShell>
  );
}

export default function AgentPage() {
  return (
    <AgentGuard>
      <AgentOverview />
    </AgentGuard>
  );
}