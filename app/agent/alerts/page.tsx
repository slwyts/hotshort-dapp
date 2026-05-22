"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import Swal from "sweetalert2";
import { AgentGuard } from "@/components/agent-guard";
import { AgentShell } from "@/components/agent/agent-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { cn, formatNumber, shortenAddress } from "@/lib/utils";
import type { AgentAlert } from "@/components/agent/types";

function AlertsContent() {
  const { jwt, signIn } = useSiweJwt();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<AgentAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const resp = await api.get<{ items: AgentAlert[] }>(`${endpoints.agentAlerts}${unreadOnly ? "?unreadOnly=1" : ""}`, token);
      setItems(resp.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [jwt, signIn, unreadOnly]);

  const ackAll = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    const ids = items.filter((item) => item.unread).map((item) => item.id);
    if (ids.length === 0) return;
    await api.post(endpoints.agentAlertAck, { alertIds: ids }, token);
    await Swal.fire({ icon: "success", title: "已标记为已读", timer: 1200, showConfirmButton: false, background: "#141419", color: "#fff" });
    await load();
  };

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AgentShell>
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2"><Bell className="h-5 w-5 text-amber-300" /> 大额交易预警</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button variant={unreadOnly ? "default" : "outline"} size="sm" onClick={() => setUnreadOnly((value) => !value)}>
              {unreadOnly ? "只看未读" : "查看全部"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void ackAll()}>
              <CheckCheck className="h-4 w-4" /> 全部已读
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loader2 className="mx-auto my-12 h-6 w-6 animate-spin text-white/40" />
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-sm text-white/40">暂无预警</div>
          ) : (
            <div className="divide-y divide-white/5">
              {items.map((item) => (
                <Link key={item.id} href={`/agent/users/${item.user}`} className="grid gap-2 py-4 text-sm hover:bg-white/[0.02] sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-white">{item.label}</span>
                      <span className={cn(
                        "rounded border px-2 py-0.5 text-xs",
                        item.unread ? "border-amber-400/30 bg-amber-400/10 text-amber-300" : "border-white/10 bg-white/5 text-white/45",
                      )}>{item.unread ? "未读" : "已读"}</span>
                    </div>
                    <div className="mt-1 font-mono text-xs text-white/45">{shortenAddress(item.user, 6)} · {item.amount}</div>
                  </div>
                  <div className="sm:text-right">
                    <div className="font-bold text-amber-300">${formatNumber(Number(item.usdtValue), 2)}</div>
                    <div className="mt-1 text-xs text-white/35">{item.occurredAt ? new Date(item.occurredAt * 1000).toLocaleString() : "-"}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </AgentShell>
  );
}

export default function AgentAlertsPage() {
  return (
    <AgentGuard>
      <AlertsContent />
    </AgentGuard>
  );
}