"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, Coins } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
      await Swal.fire({ icon: "warning", title: "请输入有效股价", background: "#141419", color: "#fff" });
      return;
    }
    setSaving(true);
    try {
      await api.post(endpoints.adminStockPrice, { priceUsdt: num }, token);
      await Swal.fire({
        icon: "success",
        title: "已保存",
        text: "新股价立即生效（影响每日分红 / 闪兑折算）",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Coins className="h-6 w-6 text-[#00c6ff]" /> 非小号股价手动设值
        </h1>
        <p className="mt-1 text-sm text-white/50">
          手动调整非小号股票价格。建议按 1 年翻 3 倍 / 2 年翻 5 倍的节奏调价。
        </p>

        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>当前股价</CardTitle>
            <CardDescription>
              {updatedAt ? `上次更新 ${new Date(updatedAt * 1000).toLocaleString("zh-CN")}` : "尚未设置"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : (
              <>
                <div>
                  <label className="text-xs uppercase tracking-widest text-white/50">USDT / 股</label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
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
