"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Mail, Check, X } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { shortenAddress, formatNumber, cn } from "@/lib/utils";

interface Item {
  id: string;
  user: string;
  hotshort_account: string;
  burn_total: string;
  status: "pending" | "sent" | "rejected";
  submitted_at: number;
}

export default function AdminAirdropPage() {
  const { jwt, signIn } = useSiweJwt();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<{ items: Item[] }>(endpoints.adminAirdrop, token);
      setItems(r.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setStatus = async (id: string, status: "sent" | "rejected") => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    try {
      await api.post(endpoints.adminAirdrop, { id, status }, token);
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Mail className="h-6 w-6 text-[#00c6ff]" /> hotshort 空投表单
        </h1>
        <p className="mt-1 text-sm text-white/50">
          README §4.5 — 燃烧 ≥ 1000U 用户提交的 hotshort 账户名，审核后线下/链下发放。
        </p>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>提交列表（最近 200 条）</CardTitle>
            <CardDescription>状态：pending / sent / rejected</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : items.length === 0 ? (
              <div className="py-8 text-center text-sm text-white/40">暂无提交</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs uppercase text-white/40">
                      <th className="px-2 py-2">提交时间</th>
                      <th className="px-2 py-2">钱包</th>
                      <th className="px-2 py-2">hotshort 账户</th>
                      <th className="px-2 py-2 text-right">累计燃烧 HS</th>
                      <th className="px-2 py-2">状态</th>
                      <th className="px-2 py-2 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.id} className="border-b border-white/5">
                        <td className="px-2 py-2 text-xs text-white/50">
                          {new Date(it.submitted_at * 1000).toLocaleString("zh-CN")}
                        </td>
                        <td className="px-2 py-2 font-mono text-xs">{shortenAddress(it.user, 6)}</td>
                        <td className="px-2 py-2 font-bold text-white">{it.hotshort_account}</td>
                        <td className="px-2 py-2 text-right">
                          {formatNumber(Number(BigInt(it.burn_total)) / 1e18, 0)}
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                              it.status === "pending" && "bg-yellow-500/10 text-yellow-300",
                              it.status === "sent" && "bg-green-500/10 text-green-300",
                              it.status === "rejected" && "bg-red-500/10 text-red-300",
                            )}
                          >
                            {it.status}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex justify-end gap-1">
                            {it.status !== "sent" && (
                              <Button size="sm" onClick={() => setStatus(it.id, "sent")}>
                                <Check className="h-3 w-3" />
                              </Button>
                            )}
                            {it.status !== "rejected" && (
                              <Button size="sm" variant="danger" onClick={() => setStatus(it.id, "rejected")}>
                                <X className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}
