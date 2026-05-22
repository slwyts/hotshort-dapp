"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ShieldAlert, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import type { AgentMe } from "@/components/agent/types";

export function AgentGuard({ children }: { children: React.ReactNode }) {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const [agent, setAgent] = useState<AgentMe | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);

  const checkAgent = useCallback(async () => {
    if (!isConnected) {
      setAgent(null);
      setChecked(true);
      return;
    }
    const token = jwt ?? (await signIn());
    if (!token) {
      setAgent(null);
      setChecked(true);
      return;
    }
    setLoading(true);
    try {
      const me = await api.get<AgentMe>(endpoints.agentMe, token);
      setAgent(me.isAgent ? me : null);
    } catch {
      setAgent(null);
    } finally {
      setChecked(true);
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void checkAgent();
  }, [checkAgent]);

  if (loading || !checked) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md items-center justify-center px-4">
        <Loader2 className="h-6 w-6 animate-spin text-white/40" />
      </div>
    );
  }

  if (!isConnected || !agent) {
    return (
      <div className="mx-auto max-w-md px-4 py-12">
        <Card>
          <CardContent className="space-y-4 py-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-amber-400/20 bg-amber-400/10">
              <ShieldAlert className="h-6 w-6 text-amber-300" />
            </div>
            <div>
              <div className="text-base font-bold text-white">当前钱包未开通代理后台权限</div>
              <p className="mt-2 text-sm text-white/50">请使用总后台已授权的代理钱包访问。</p>
            </div>
            <Button variant="outline" onClick={() => void checkAgent()}>重新检查</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}