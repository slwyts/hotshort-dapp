"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount, useReadContract } from "wagmi";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useContracts } from "@/lib/runtime-config";
import { VAULT_ABI } from "@/lib/contracts/abis";

const ADMIN_FORCE_KEY = "hotshort_admin_force";

export function AdminEntryCard() {
  const { address, isConnected } = useAccount();
  const searchParams = useSearchParams();
  const { vault } = useContracts();
  const [forceEnabled, setForceEnabled] = useState(false);
  const { data: onchainOwner } = useReadContract({
    abi: VAULT_ABI,
    address: vault,
    functionName: "owner",
    query: { enabled: isConnected },
  });
  const forceFromQuery = searchParams.has("force");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (forceFromQuery) {
      setForceEnabled(true);
      return;
    }
    sessionStorage.removeItem(ADMIN_FORCE_KEY);
    setForceEnabled(false);
  }, [forceFromQuery]);

  const allowed =
    !!address &&
    !!onchainOwner &&
    address.toLowerCase() === (onchainOwner as string).toLowerCase();

  if (!allowed && !forceFromQuery && !forceEnabled) return null;

  return (
    <a href={forceFromQuery || forceEnabled ? "/admin?force" : "/admin"} className="block">
      <Card className="border-[#b829ff]/25 bg-[#b829ff]/5 transition hover:border-[#b829ff]/50 hover:bg-[#b829ff]/10">
        <CardContent className="flex items-center gap-3 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#b829ff]/30 bg-[#b829ff]/10">
            <ShieldCheck className="h-5 w-5 text-[#b829ff]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-white">管理后台</div>
            <div className="mt-0.5 truncate text-xs text-white/45">收益率、彩票、资金与系统配置</div>
          </div>
          <ChevronRight className="h-4 w-4 text-white/35" />
        </CardContent>
      </Card>
    </a>
  );
}
