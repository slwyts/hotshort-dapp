"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, Coins, ChevronLeft } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";

export default function AdminStockPricePage() {
  const { jwt, signIn } = useSiweJwt();
  const [price, setPrice] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ priceUsdt: number; updatedAt: number | null }>(
        endpoints.stockPrice,
      );
      setPrice(String(r.priceUsdt));
      setUpdatedAt(r.updatedAt);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    const num = Number(price);
    if (!Number.isFinite(num) || num <= 0) {
      await Swal.fire({ icon: "warning", title: "请输入有效价格", background: "#141419", color: "#fff" });
      return;
    }
    setSaving(true);
    try {
      await api.post(endpoints.adminStockPrice, { priceUsdt: num }, token);
      await Swal.fire({
        icon: "success",
        title: "保存成功",
        text: "新股价立即生效，影响每日分红和闪兑折算",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "保存失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Coins className="h-6 w-6 text-[#00c6ff]" /> 股价管理
        </h1>
        <p className="mt-1 text-sm text-white/50">
          手动调整当前股票价格，修改后立即生效
        </p>

        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>当前股价</CardTitle>
            {updatedAt && (
              <p className="text-xs text-white/40">
                上次更新：{new Date(updatedAt * 1000).toLocaleString("zh-CN")}
              </p>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium text-white/70">每股价格</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                    />
                    <span className="text-sm text-white/40">USDT</span>
                  </div>
                </div>
                <Button onClick={save} disabled={saving} className="ml-auto">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  保存
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}
