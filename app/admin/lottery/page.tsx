"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Save, Play, History } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";

interface Cfg {
  ticketPriceUsdt: number;
  weeklyRefillHs: number;
  currentRound: number;
}

export default function AdminLotteryPage() {
  const { jwt, signIn } = useSiweJwt();
  const [cfg, setCfg] = useState<Cfg>({ ticketPriceUsdt: 1, weeklyRefillHs: 100_000, currentRound: 1 });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawing, setDrawing] = useState(false);

  const refresh = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<Cfg>(endpoints.adminLottery, token);
      setCfg(r);
    } finally {
      setLoading(false);
    }
  }, [jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    if (cfg.ticketPriceUsdt <= 0 || cfg.weeklyRefillHs < 0) {
      await Swal.fire({ icon: "warning", title: "参数无效", background: "#141419", color: "#fff" });
      return;
    }
    setSaving(true);
    try {
      await api.post(endpoints.adminLottery, cfg, token);
      await Swal.fire({ icon: "success", title: "已保存", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  const draw = async () => {
    const c = await Swal.fire({
      icon: "warning",
      title: "确认手动开奖？",
      text: "通常由 cron 周一 00:00 自动开奖，仅紧急情况手动触发。",
      showCancelButton: true,
      confirmButtonText: "开奖",
      confirmButtonColor: "#b829ff",
      cancelButtonText: "取消",
      background: "#141419",
      color: "#fff",
    });
    if (!c.isConfirmed) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setDrawing(true);
    try {
      const r = await api.post<{ roundNo: number; winning: string; settledTickets: number }>(
        "/admin/lottery-draw",
        {},
        token,
      );
      await Swal.fire({
        icon: "success",
        title: `第 ${r.roundNo} 期开奖`,
        html: `中奖号码 <strong style="color:#b829ff;font-family:monospace;font-size:1.4em">${r.winning}</strong><br/>
               共结算 ${r.settledTickets} 张中奖票`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setDrawing(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-black flex items-center gap-2">
          <History className="h-6 w-6 text-[#00c6ff]" /> 彩票配置
        </h1>
        <p className="mt-1 text-sm text-white/50">
          README §三：每周一 00:00 (UTC+8) cron 自动开奖；门票价、奖池补给可改。
        </p>

        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>当期：第 {cfg.currentRound} 期</CardTitle>
            <CardDescription>修改后立即生效（影响下一笔购票）</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : (
              <>
                <div>
                  <label className="text-xs uppercase tracking-widest text-white/50">门票价（USDT）</label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={cfg.ticketPriceUsdt}
                    onChange={(e) => setCfg({ ...cfg, ticketPriceUsdt: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-widest text-white/50">每周补给奖池（HS）</label>
                  <Input
                    type="number"
                    min={0}
                    value={cfg.weeklyRefillHs}
                    onChange={(e) => setCfg({ ...cfg, weeklyRefillHs: Number(e.target.value) })}
                  />
                </div>
                <div className="flex justify-between gap-2 pt-2">
                  <Button variant="danger" onClick={draw} disabled={drawing}>
                    {drawing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    手动开奖
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}
