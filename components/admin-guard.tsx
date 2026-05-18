"use client";

import { useAccount, useReadContract } from "wagmi";
import { Shield, Loader2 } from "lucide-react";
import { useContracts } from "@/lib/runtime-config";
import { VAULT_ABI } from "@/lib/contracts/abis";
import { Card, CardContent } from "@/components/ui/card";
import { ConnectButton } from "@/components/connect-button";

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { vault } = useContracts();
  const { data: onchainOwner, isLoading } = useReadContract({
    abi: VAULT_ABI,
    address: vault,
    functionName: "owner",
    query: { enabled: isConnected },
  });

  const allowed =
    !!address &&
    !!onchainOwner &&
    address.toLowerCase() === (onchainOwner as string).toLowerCase();

  if (!isConnected) {
    return (
      <div className="container mx-auto px-4 py-20">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Shield className="h-12 w-12 text-[#b829ff]" />
            <p className="text-lg font-bold">管理员后台</p>
            <p className="text-sm text-white/50">需要使用 owner 钱包登录</p>
            <ConnectButton />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-20">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-white/40" />
            <p className="text-sm text-white/50">校验 owner 中…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="container mx-auto px-4 py-20">
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Shield className="h-10 w-10 text-red-400" />
            <p className="text-lg font-bold">无权访问</p>
            <p className="text-sm text-white/50">当前钱包不是合约 owner</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
