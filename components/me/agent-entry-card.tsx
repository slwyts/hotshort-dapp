"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { BriefcaseBusiness, ChevronRight, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import type { AgentMe } from "@/components/agent/types";

export function AgentEntryCard() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const [agent, setAgent] = useState<AgentMe | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isConnected) {
      setAgent(null);
      return;
    }
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const resp = await api.get<AgentMe>(endpoints.agentMe, token);
      setAgent(resp.isAgent ? resp : null);
    } catch {
      setAgent(null);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!agent) return null;

  return (
    <Link href="/agent" className="block">
      <Card className="border-[#00c6ff]/20 bg-[#00c6ff]/5 transition hover:border-[#00c6ff]/45 hover:bg-[#00c6ff]/10">
        <CardContent className="flex items-center gap-3 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#00c6ff]/25 bg-[#00c6ff]/10">
            <BriefcaseBusiness className="h-5 w-5 text-[#00c6ff]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-white">代理商后台</div>
            <div className="mt-0.5 truncate text-xs text-white/45">{agent.label || "查看旗下用户、交易明细和预警"}</div>
          </div>
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-white/35" /> : <ChevronRight className="h-4 w-4 text-white/35" />}
        </CardContent>
      </Card>
    </Link>
  );
}