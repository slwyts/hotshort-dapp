"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, Save, Play, Ticket, ChevronLeft } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [forceWinning, setForceWinning] = useState("");

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
      await Swal.fire({ icon: "warning", title: "参数无效", text: "请检查门票价格和奖池补给数量", background: "#141419", color: "#fff" });
      return;
    }
    setSaving(true);
    try {
      await api.post(endpoints.adminLottery, cfg, token);
      await Swal.fire({ icon: "success", title: "保存成功", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "保存失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  const draw = async () => {
    const useForce = forceWinning.trim() !== "";
    if (useForce && !/^\d{6}$/.test(forceWinning.trim())) {
      await Swal.fire({ icon: "warning", title: "中奖号格式错误", text: "请输入 6 位数字", background: "#141419", color: "#fff" });
      return;
    }
    const c = await Swal.fire({
      icon: "warning",
      title: useForce ? `用 ${forceWinning.trim()} 开奖？` : "确认手动开奖？",
      text: useForce
        ? "将跳过薄饼同步直接以此号码结算本期"
        : "通常由系统每周一自动开奖，仅紧急情况手动触发",
      showCancelButton: true,
      confirmButtonText: "确认开奖",
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
      const r = await api.post<{ roundNo: number; winning: string; settledTickets: number; pending?: boolean; reason?: string }>(
        "/admin/lottery-draw",
        useForce ? { winning: forceWinning.trim() } : {},
        token,
      );
      if (r.pending) {
        await Swal.fire({
          icon: "info",
          title: `第 ${r.roundNo} 期暂未开奖`,
          text: r.reason ?? "薄饼官方结果尚未可读",
          background: "#141419",
          color: "#fff",
          confirmButtonColor: "#b829ff",
        });
      } else {
        await Swal.fire({
          icon: "success",
          title: `第 ${r.roundNo} 期开奖完成`,
          html: `中奖号码 <strong style="color:#b829ff;font-family:monospace;font-size:1.4em">${r.winning}</strong><br/>
                 共结算 ${r.settledTickets} 张中奖彩票`,
          background: "#141419",
          color: "#fff",
          confirmButtonColor: "#b829ff",
        });
        setForceWinning("");
      }
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "开奖失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setDrawing(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Ticket className="h-6 w-6 text-[#00c6ff]" /> 彩票管理
        </h1>
        <p className="mt-1 text-sm text-white/50">
          门票定价与开奖控制
        </p>

        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>当前第 {cfg.currentRound} 期</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium text-white/70">门票价格</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={cfg.ticketPriceUsdt}
                      onChange={(e) => setCfg({ ...cfg, ticketPriceUsdt: Number(e.target.value) })}
                    />
                    <span className="text-sm text-white/40">USDT</span>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-white/70">每周奖池补给</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      value={cfg.weeklyRefillHs}
                      onChange={(e) => setCfg({ ...cfg, weeklyRefillHs: Number(e.target.value) })}
                    />
                    <span className="text-sm text-white/40">HS</span>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-white/70">自定义中奖号（可选）</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="留空则同步薄饼官方"
                      value={forceWinning}
                      onChange={(e) => setForceWinning(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      className="font-mono"
                    />
                    <span className="text-sm text-white/40">6 位</span>
                  </div>
                  <p className="mt-1 text-[11px] text-white/40">
                    填了就用此号开奖（测试 / 薄饼延迟兜底），留空走官方同步
                  </p>
                </div>
                <div className="flex justify-between gap-3 pt-2 border-t border-white/5">
                  <Button variant="danger" onClick={draw} disabled={drawing}>
                    {drawing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {forceWinning.trim() ? "按指定号开奖" : "手动开奖"}
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存配置
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
