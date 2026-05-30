"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Wrench, Clock, Database } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminGuard } from "@/components/admin-guard";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";

interface TimeDebugInfo {
  systemTime: number;
  realTime: number;
  offsetSeconds: number;
  testMode: boolean;
}

function toUtc8(ts: number): string {
  return new Date(ts * 1000 + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function offsetLabel(seconds: number, t: (k: string) => string): string {
  if (seconds === 0) return t("debug.offsetNone");
  const sign = seconds >= 0 ? "+" : "";
  const abs = Math.abs(seconds);
  if (abs < 60) return `${sign}${abs} ${t("debug.offsetUnit")}`;
  if (abs < 3600) return `${sign}${Math.round(abs / 60)} 分钟`;
  if (abs < 86400) return `${sign}${Math.round(abs / 3600)} 小时`;
  return `${sign}${Math.round(abs / 86400)} 天`;
}

const OFFSET_UNITS = [
  { key: "sec", labelZh: "秒", labelEn: "sec", mul: 1 },
  { key: "min", labelZh: "分", labelEn: "min", mul: 60 },
  { key: "hour", labelZh: "时", labelEn: "hr", mul: 3600 },
  { key: "day", labelZh: "天", labelEn: "day", mul: 86400 },
] as const;

type OffsetUnitKey = (typeof OFFSET_UNITS)[number]["key"];

export default function AdvancedDebugPage() {
  const { t } = useLocale();
  const { jwt, signIn } = useSiweJwt();
  const [info, setInfo] = useState<TimeDebugInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [setting, setSetting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [customOffsetVal, setCustomOffsetVal] = useState("");
  const [customOffsetUnit, setCustomOffsetUnit] = useState<OffsetUnitKey>("sec");

  // 测试模式下完全禁用时间控件
  const timeLocked = info?.testMode === true;

  const refresh = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<TimeDebugInfo>(endpoints.adminTimeDebug, token);
      setInfo(r);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyOffset = async (seconds: number) => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSetting(true);
    try {
      const r = await api.post<TimeDebugInfo>(endpoints.adminTimeDebug, { offsetSeconds: seconds }, token);
      setInfo(r);
    } catch (e) {
      await Swal.fire({
        icon: "error",
        title: "Error",
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setSetting(false);
    }
  };

  /** 带二次确认 + 3s 倒计时的偏移应用 */
  const applyWithConfirm = async (seconds: number, label: string) => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    const result = await Swal.fire({
      icon: "question",
      title: t("debug.timeConfirm"),
      html: t("debug.timeConfirmBody", { offset: label }),
      background: "#141419",
      color: "#fff",
      showCancelButton: true,
      confirmButtonText: t("common.confirm"),
      cancelButtonText: t("common.cancel"),
      confirmButtonColor: "#f59e0b",
      cancelButtonColor: "#374151",
      reverseButtons: true,
      didOpen: () => {
        const confirmBtn = Swal.getConfirmButton();
        if (!confirmBtn) return;
        confirmBtn.disabled = true;
        let sec = 3;
        confirmBtn.textContent = `${t("common.confirm")} (${sec}s)`;
        const timer = setInterval(() => {
          sec--;
          if (sec <= 0) {
            clearInterval(timer);
            confirmBtn.disabled = false;
            confirmBtn.textContent = t("common.confirm");
          } else {
            confirmBtn.textContent = `${t("common.confirm")} (${sec}s)`;
          }
        }, 1000);
      },
    });
    if (!result.isConfirmed) return;
    void applyOffset(seconds);
  };

  const handleCustomOffset = () => {
    const val = Number(customOffsetVal);
    if (!Number.isFinite(val) || val <= 0) return;
    const unit = OFFSET_UNITS.find((u) => u.key === customOffsetUnit)!;
    const totalSec = val * unit.mul;
    const locale = (typeof navigator !== "undefined" ? navigator.language : "zh-CN").startsWith("zh") ? "zh" : "en";
    const unitLabel = locale === "zh" ? unit.labelZh : unit.labelEn;
    setCustomOffsetVal("");
    void applyWithConfirm(totalSec, `${val} ${unitLabel}`);
  };

  const handleResetDb = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;

    // 二次确认弹窗：确认按钮先禁用 3 秒
    const result = await Swal.fire({
      icon: "warning",
      title: t("debug.resetConfirm"),
      html: `
        <p style="color:#f87171;font-size:14px;margin:0 0 12px 0">${t("debug.resetConfirmBody")}</p>
        <p id="swal-countdown" style="color:#f59e0b;font-size:13px;margin:0">${t("debug.resetCooldown", { sec: "3" })}</p>
      `,
      background: "#141419",
      color: "#fff",
      showCancelButton: true,
      confirmButtonText: t("common.confirm"),
      cancelButtonText: t("common.cancel"),
      confirmButtonColor: "#ef4444",
      cancelButtonColor: "#374151",
      reverseButtons: true,
      didOpen: () => {
        const confirmBtn = Swal.getConfirmButton();
        if (!confirmBtn) return;
        confirmBtn.disabled = true;
        let sec = 3;
        confirmBtn.textContent = `${t("common.confirm")} (${sec}s)`;
        const timer = setInterval(() => {
          sec--;
          if (sec <= 0) {
            clearInterval(timer);
            confirmBtn.disabled = false;
            confirmBtn.textContent = t("common.confirm");
            const cd = document.getElementById("swal-countdown");
            if (cd) cd.style.display = "none";
          } else {
            confirmBtn.textContent = `${t("common.confirm")} (${sec}s)`;
            const cd = document.getElementById("swal-countdown");
            if (cd) cd.textContent = t("debug.resetCooldown", { sec: String(sec) });
          }
        }, 1000);
      },
    });
    if (!result.isConfirmed) return;

    setResetting(true);
    try {
      const r = await api.post<{ reset: boolean; tables: number; cursorBlock: number }>(
        endpoints.adminResetDb,
        {},
        token,
      );
      await Swal.fire({
        icon: "success",
        title: t("debug.resetSuccess"),
        html: t("debug.resetSuccessBody", { tables: String(r.tables), block: String(r.cursorBlock) }),
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({
        icon: "error",
        title: t("debug.resetFailed"),
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="flex items-center gap-3 text-3xl font-black neon-text">
          <Wrench className="h-7 w-7 text-[#f59e0b]" />
          {t("debug.title")}
        </h1>
        <p className="mt-2 text-sm text-white/50">{t("debug.desc")}</p>

        {loading && !info ? (
          <div className="mt-8 py-16 text-center text-white/40">
            <Loader2 className="mx-auto h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            {/* 时间调试 */}
            <Card className={`border-[#f59e0b]/30 ${timeLocked ? "opacity-60" : ""}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Clock className="h-5 w-5 text-[#f59e0b]" />
                  {t("debug.timeSection")}
                </CardTitle>
                {timeLocked && (
                  <CardDescription className="text-[#f59e0b]">
                    {t("debug.testModeDisabled")}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/5 bg-black/40 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-white/40">
                      {t("debug.systemTime")}
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold text-white">
                      {info ? toUtc8(info.systemTime) : "—"}
                    </div>
                    <div className="mt-0.5 text-[10px] text-white/30">UTC+8</div>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-black/40 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-white/40">
                      {t("debug.realTime")}
                    </div>
                    <div className="mt-1 font-mono text-sm font-bold text-white/60">
                      {info ? toUtc8(info.realTime) : "—"}
                    </div>
                    <div className="mt-0.5 text-[10px] text-white/30">UTC+8</div>
                  </div>
                </div>

                <div className="rounded-xl border border-white/5 bg-black/40 p-3">
                  <span className="text-[10px] uppercase tracking-widest text-white/40">
                    {t("debug.offset")}
                  </span>
                  <span className="ml-2 font-mono text-sm font-bold text-[#f59e0b]">
                    {info ? offsetLabel(info.offsetSeconds, t) : "—"}
                  </span>
                </div>

                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
                    {t("debug.quickAdjust")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => applyWithConfirm(0, "0")}
                    >
                      {t("debug.btnReset")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => applyWithConfirm(3600, "+1 小时")}
                    >
                      {t("debug.btnPlus1h")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => applyWithConfirm(86400, "+1 天")}
                    >
                      {t("debug.btnPlus1d")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => applyWithConfirm(7 * 86400, "+7 天")}
                    >
                      {t("debug.btnPlus7d")}
                    </Button>
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
                    {t("debug.customOffset")}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder={t("debug.customOffset")}
                      value={customOffsetVal}
                      disabled={timeLocked}
                      onChange={(e) => setCustomOffsetVal(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCustomOffset()}
                      className="h-9 w-28 font-mono text-xs"
                    />
                    <div className="inline-flex h-9 overflow-hidden rounded-md border border-white/10 bg-black/40">
                      {OFFSET_UNITS.map((u) => (
                        <button
                          key={u.key}
                          type="button"
                          disabled={timeLocked}
                          onClick={() => setCustomOffsetUnit(u.key)}
                          className={`h-full px-3 text-xs font-medium transition-colors ${
                            customOffsetUnit === u.key
                              ? "bg-[#f59e0b]/20 text-[#f59e0b]"
                              : "text-white/50 hover:text-white/80"
                          } ${u.key !== "day" ? "border-r border-white/10" : ""}`}
                        >
                          {u.labelZh}
                        </button>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting || !customOffsetVal}
                      onClick={handleCustomOffset}
                    >
                      {setting ? <Loader2 className="h-3 w-3 animate-spin" /> : t("common.submit")}
                    </Button>
                  </div>
                </div>

                <div className="rounded-md border border-[#f59e0b]/20 bg-[#f59e0b]/5 px-3 py-2 text-[11px] text-[#f59e0b]/80">
                  {t("debug.timeWarning")}
                </div>
              </CardContent>
            </Card>

            {/* 数据库重置 */}
            <Card className="border-[#ef4444]/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Database className="h-5 w-5 text-[#ef4444]" />
                  {t("debug.resetSection")}
                </CardTitle>
                <CardDescription>{t("debug.resetDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  variant="danger"
                  size="lg"
                  className="w-full"
                  disabled={resetting}
                  onClick={() => void handleResetDb()}
                >
                  {resetting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t("debug.resetBtn")
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </AdminGuard>
  );
}
