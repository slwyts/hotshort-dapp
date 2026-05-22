"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, Loader2 } from "lucide-react";
import { AgentGuard } from "@/components/agent-guard";
import { AgentShell } from "@/components/agent/agent-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { cn, formatNumber, shortenAddress } from "@/lib/utils";
import type { AgentFunds, AgentTransaction, AgentUser } from "@/components/agent/types";

const DIRECTION_LABEL: Record<string, string> = {
  deposit: "入金",
  withdraw: "出金",
  spend: "消耗",
  credit: "入账",
};

function FundsGrid({ funds }: { funds: AgentFunds }) {
  const items = [
    ["质押中", funds.stakeUsdt],
    ["套餐", funds.aiPackageUsdt],
    ["股票折 U", funds.stockUsdt],
    ["待领", funds.pendingUsdt],
    ["累计入金", funds.totalInUsdt],
    ["累计出金", funds.totalOutUsdt],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-white/8 bg-white/[0.03] p-4">
          <div className="text-xs text-white/45">{label}</div>
          <div className="mt-1 text-lg font-bold text-white">${formatNumber(Number(value), 2)}</div>
        </div>
      ))}
    </div>
  );
}

function UserDetailContent() {
  const params = useParams<{ address: string }>();
  const address = params.address;
  const { jwt, signIn } = useSiweJwt();
  const [user, setUser] = useState<AgentUser | null>(null);
  const [funds, setFunds] = useState<AgentFunds | null>(null);
  const [txs, setTxs] = useState<AgentTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token || !address) return;
    setLoading(true);
    try {
      const [detail, transactions] = await Promise.all([
        api.get<{ user: Omit<AgentUser, "funds">; funds: AgentFunds }>(endpoints.agentUserDetail(address), token),
        api.get<{ items: AgentTransaction[] }>(endpoints.agentUserTransactions(address), token),
      ]);
      setUser({ ...detail.user, funds: detail.funds });
      setFunds(detail.funds);
      setTxs(transactions.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [address, jwt, signIn]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AgentShell>
      <Link href="/agent/users" className="mb-4 inline-flex items-center gap-1 text-sm text-white/45 hover:text-white">
        <ChevronLeft className="h-4 w-4" /> 返回用户列表
      </Link>
      {loading ? (
        <Loader2 className="mx-auto mt-12 h-6 w-6 animate-spin text-white/40" />
      ) : !user || !funds ? (
        <Card><CardContent className="py-10 text-center text-sm text-white/40">用户不存在或不属于当前代理</CardContent></Card>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-sm">{shortenAddress(user.address, 8)}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm text-white/60 sm:grid-cols-3">
              <div>代数：<span className="text-white">{user.generation} 代</span></div>
              <div>邀请码：<span className="text-white">{user.referralCode ?? "-"}</span></div>
              <div>上级：<span className="font-mono text-white">{user.referrer ? shortenAddress(user.referrer, 6) : "-"}</span></div>
            </CardContent>
          </Card>

          <FundsGrid funds={funds} />

          <Card>
            <CardHeader><CardTitle>交易明细</CardTitle></CardHeader>
            <CardContent>
              {txs.length === 0 ? (
                <div className="py-10 text-center text-sm text-white/40">暂无交易</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs text-white/40">
                        <th className="px-3 py-3">类型</th>
                        <th className="px-3 py-3">方向</th>
                        <th className="px-3 py-3">数量</th>
                        <th className="px-3 py-3 text-right">折合 U</th>
                        <th className="px-3 py-3 text-right">时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {txs.map((tx) => (
                        <tr key={tx.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                          <td className="px-3 py-3 text-white/80">{tx.label}</td>
                          <td className="px-3 py-3">
                            <span className={cn(
                              "rounded border px-2 py-1 text-xs",
                              tx.direction === "deposit" ? "border-green-400/25 bg-green-400/10 text-green-300" :
                              tx.direction === "withdraw" ? "border-amber-400/25 bg-amber-400/10 text-amber-300" :
                              tx.direction === "spend" ? "border-red-400/25 bg-red-400/10 text-red-300" :
                              "border-sky-400/25 bg-sky-400/10 text-sky-300",
                            )}>{DIRECTION_LABEL[tx.direction] ?? tx.direction}</span>
                          </td>
                          <td className="px-3 py-3 text-white/60">{tx.amount}</td>
                          <td className="px-3 py-3 text-right">{formatNumber(Number(tx.usdtValue), 2)}</td>
                          <td className="px-3 py-3 text-right text-white/45">{tx.occurredAt ? new Date(tx.occurredAt * 1000).toLocaleString() : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </AgentShell>
  );
}

export default function AgentUserDetailPage() {
  return (
    <AgentGuard>
      <UserDetailContent />
    </AgentGuard>
  );
}