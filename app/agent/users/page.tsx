"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Search, ChevronRight } from "lucide-react";
import { AgentGuard } from "@/components/agent-guard";
import { AgentShell } from "@/components/agent/agent-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { formatNumber, shortenAddress } from "@/lib/utils";
import type { AgentUser } from "@/components/agent/types";

function UsersPageContent() {
  const { jwt, signIn } = useSiweJwt();
  const [keyword, setKeyword] = useState("");
  const [rows, setRows] = useState<AgentUser[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const resp = await api.get<{ items: AgentUser[] }>(`${endpoints.agentUsers}${keyword ? `?q=${encodeURIComponent(keyword)}` : ""}`, token);
      setRows(resp.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [jwt, keyword, signIn]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AgentShell>
      <Card>
        <CardHeader>
          <CardTitle>旗下用户</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row">
            <div className="relative max-w-lg flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void load();
                }}
                placeholder="搜索钱包地址、邀请码或上级地址"
                className="pl-9"
              />
            </div>
            <Button variant="outline" onClick={() => void load()}>搜索</Button>
          </div>

          {loading ? (
            <Loader2 className="mx-auto my-12 h-6 w-6 animate-spin text-white/40" />
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-white/40">暂无旗下用户</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs text-white/40">
                    <th className="px-3 py-3">用户</th>
                    <th className="px-3 py-3">代数</th>
                    <th className="px-3 py-3">邀请码</th>
                    <th className="px-3 py-3 text-right">入金 U</th>
                    <th className="px-3 py-3 text-right">出金 U</th>
                    <th className="px-3 py-3 text-right">待领 U</th>
                    <th className="px-3 py-3 text-right">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.address} className="border-b border-white/5 hover:bg-white/[0.03]">
                      <td className="px-3 py-3 font-mono text-xs text-white/75">{shortenAddress(row.address, 6)}</td>
                      <td className="px-3 py-3">{row.generation} 代</td>
                      <td className="px-3 py-3 text-white/55">{row.referralCode ?? "-"}</td>
                      <td className="px-3 py-3 text-right">{formatNumber(Number(row.funds.totalInUsdt), 2)}</td>
                      <td className="px-3 py-3 text-right">{formatNumber(Number(row.funds.totalOutUsdt), 2)}</td>
                      <td className="px-3 py-3 text-right text-[#00c6ff]">{formatNumber(Number(row.funds.pendingUsdt), 2)}</td>
                      <td className="px-3 py-3 text-right">
                        <Link href={`/agent/users/${row.address}`} className="inline-flex items-center justify-end text-white/45 hover:text-white">
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </AgentShell>
  );
}

export default function AgentUsersPage() {
  return (
    <AgentGuard>
      <UsersPageContent />
    </AgentGuard>
  );
}