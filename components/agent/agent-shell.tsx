"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, LayoutDashboard, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/agent", label: "总览", icon: LayoutDashboard },
  { href: "/agent/users", label: "用户", icon: Users },
  { href: "/agent/alerts", label: "预警", icon: Bell },
];

export function AgentShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 pb-24 sm:px-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-black text-white">代理商后台</h1>
          <p className="mt-1 text-sm text-white/50">只读查看旗下三代用户数据、交易明细和大额预警。</p>
        </div>
        <div className="flex overflow-x-auto rounded-lg border border-white/10 bg-black/35 p-1">
          {nav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition",
                  active ? "bg-white/10 text-white" : "text-white/50 hover:text-white",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
      {children}
    </div>
  );
}