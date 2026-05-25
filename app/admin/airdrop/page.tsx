"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, Flame, Check, X, ChevronLeft } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  pending: { text: "待审核", cls: "bg-yellow-500/10 text-yellow-300" },
  sent: { text: "已发放", cls: "bg-green-500/10 text-green-300" },
  rejected: { text: "已拒绝", cls: "bg-red-500/10 text-red-300" },
};

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
      await Swal.fire({ icon: "error", title: "操作失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Flame className="h-6 w-6 text-[#00c6ff]" /> 版权空投
        </h1>
        <p className="mt-1 text-sm text-white/50">
          累计燃烧 HS 的 U 价值满 1000U 后，用户提交 Hotshort 账户并在此确认发放
        </p>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>申请列表</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : items.length === 0 ? (
              <div className="py-8 text-center text-sm text-white/40">暂无申请</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-white/40">
                      <th className="px-3 py-3">提交时间</th>
                      <th className="px-3 py-3">钱包地址</th>
                      <th className="px-3 py-3">Hotshort 账户</th>
                      <th className="px-3 py-3 text-right">累计燃烧原始量 (HS)</th>
                      <th className="px-3 py-3">状态</th>
                      <th className="px-3 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => {
                      const st = STATUS_LABELS[it.status] ?? STATUS_LABELS.pending;
                      return (
                        <tr key={it.id} className={`border-b border-white/5 ${i % 2 === 0 ? "bg-white/[0.01]" : ""} hover:bg-white/[0.03]`}>
                          <td className="px-3 py-3 text-xs text-white/50">
                            {new Date(it.submitted_at * 1000).toLocaleString("zh-CN")}
                          </td>
                          <td className="px-3 py-3 font-mono text-xs">{shortenAddress(it.user, 6)}</td>
                          <td className="px-3 py-3 font-bold text-white">{it.hotshort_account}</td>
                          <td className="px-3 py-3 text-right">
                            {formatNumber(Number(BigInt(it.burn_total)) / 1e18, 0)}
                          </td>
                          <td className="px-3 py-3">
                            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", st.cls)}>
                              {st.text}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-1">
                              {it.status !== "sent" && (
                                <Button size="sm" onClick={() => setStatus(it.id, "sent")}>
                                  <Check className="h-3 w-3" /> 通过
                                </Button>
                              )}
                              {it.status !== "rejected" && (
                                <Button size="sm" variant="danger" onClick={() => setStatus(it.id, "rejected")}>
                                  <X className="h-3 w-3" /> 拒绝
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
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
