"use client";

import { useAccount } from "wagmi";
import { Shield } from "lucide-react";
import { OWNER_ADDRESSES } from "@/lib/contracts/addresses";
import { Card, CardContent } from "@/components/ui/card";
import { ConnectButton } from "@/components/connect-button";

/**
 * Admin 路由守卫：仅 NEXT_PUBLIC_OWNER_ADDRESSES 中列出的钱包可见。
 * 后端 admin/* 接口另有 SIWE + admin_config.owner_addresses 双重校验。
 */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const lower = address?.toLowerCase();
  const allowed = !!lower && (OWNER_ADDRESSES.length === 0 || OWNER_ADDRESSES.includes(lower));

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

  if (!allowed) {
    return (
      <div className="container mx-auto px-4 py-20">
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Shield className="h-10 w-10 text-red-400" />
            <p className="text-lg font-bold">无权访问</p>
            <p className="text-sm text-white/50">当前钱包不在 owner 白名单</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
