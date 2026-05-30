"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Wrench, Clock, Database, ChevronUp, ChevronDown, Target } from "lucide-react";
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

  // 时间加减（相对偏移）
  const [advanceVal, setAdvanceVal] = useState("");
  const [advanceUnit, setAdvanceUnit] = useState<OffsetUnitKey>("day");

  // 直接设定偏移（绝对）
  const [directVal, setDirectVal] = useState("");
  const [directUnit, setDirectUnit] = useState<OffsetUnitKey>("sec");

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

  /** 设置绝对偏移 */
  const setAbsoluteOffset = async (seconds: number) => {
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

  /** 相对偏移：在当前偏移基础上加减 */
  const advanceOffset = async (deltaSeconds: number, label: string) => {
    if (!info) return;
    const newOffset = info.offsetSeconds + deltaSeconds;
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
    void setAbsoluteOffset(newOffset);
  };

  const handleAdvance = () => {
    const val = Number(advanceVal);
    if (!Number.isFinite(val) || val <= 0) return;
    const unit = OFFSET_UNITS.find((u) => u.key === advanceUnit)!;
    const totalSec = val * unit.mul;
    const isZh = (typeof navigator !== "undefined" ? navigator.language : "zh-CN").startsWith("zh");
    const unitLabel = isZh ? unit.labelZh : unit.labelEn;
    setAdvanceVal("");
    void advanceOffset(totalSec, `+${val} ${unitLabel}`);
  };

  const handleDirectSet = () => {
    const val = Number(directVal);
    if (!Number.isFinite(val) || val < 0) return;
    const unit = OFFSET_UNITS.find((u) => u.key === directUnit)!;
    const totalSec = val * unit.mul;
    const isZh = (typeof navigator !== "undefined" ? navigator.language : "zh-CN").startsWith("zh");
    const unitLabel = isZh ? unit.labelZh : unit.labelEn;
    setDirectVal("");
    // 直接设定也需要确认
    Swal.fire({
      icon: "question",
      title: t("debug.timeConfirm"),
      html: t("debug.directSetConfirmBody", { offset: `${val} ${unitLabel}（${totalSec} 秒）` }),
      background: "#141419",
      color: "#fff",
      showCancelButton: true,
      confirmButtonText: t("common.confirm"),
      cancelButtonText: t("common.cancel"),
      confirmButtonColor: "#f59e0b",
      cancelButtonColor: "#374151",
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
    }).then((result) => {
      if (result.isConfirmed) void setAbsoluteOffset(totalSec);
    });
  };

  const handleResetDb = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;

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
            {/* ==================== 时间加减（相对偏移） ==================== */}
            <Card className={`border-[#f59e0b]/30 ${timeLocked ? "opacity-60" : ""}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <ChevronUp className="h-5 w-5 text-[#f59e0b]" />
                  {t("debug.timeSection")}
                </CardTitle>
                {timeLocked && (
                  <CardDescription className="text-[#f59e0b]">
                    {t("debug.testModeDisabled")}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 时间显示 */}
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

                {/* 当前偏移 */}
                <div className="rounded-xl border border-white/5 bg-black/40 p-3">
                  <span className="text-[10px] uppercase tracking-widest text-white/40">
                    {t("debug.offset")}
                  </span>
                  <span className="ml-2 font-mono text-sm font-bold text-[#f59e0b]">
                    {info ? offsetLabel(info.offsetSeconds, t) : "—"}
                  </span>
                </div>

                {/* 快捷加减 */}
                <div>
                  <div className="mb-2 text-[11px] font-medium text-white/60">
                    {t("debug.quickAdjust")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => advanceOffset(0, t("debug.btnReset"))}
                    >
                      {t("debug.btnReset")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => advanceOffset(3600, "+1 小时")}
                    >
                      +1 时
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => advanceOffset(86400, "+1 天")}
                    >
                      +1 天
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => advanceOffset(7 * 86400, "+7 天")}
                    >
                      +7 天
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={timeLocked || setting}
                      onClick={() => advanceOffset(-86400, "−1 天")}
                    >
                      −1 天
                    </Button>
                  </div>
                </div>

                {/* 自定义加减 */}
                <div>
                  <div className="mb-2 text-[11px] font-medium text-white/60">
                    {t("debug.advanceCustom")}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="数量"
                      value={advanceVal}
                      disabled={timeLocked}
                      onChange={(e) => setAdvanceVal(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAdvance()}
                      className="h-9 w-24 font-mono text-xs"
                    />
                    <div className="inline-flex h-9 overflow-hidden rounded-md border border-white/10 bg-black/40">
                      {OFFSET_UNITS.map((u) => (
                        <button
                          key={u.key}
                          type="button"
                          disabled={timeLocked}
                          onClick={() => setAdvanceUnit(u.key)}
                          className={`h-full px-3 text-xs font-medium transition-colors ${
                            advanceUnit === u.key
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
                      disabled={timeLocked || setting || !advanceVal}
                      onClick={handleAdvance}
                    >
                      {setting ? <Loader2 className="h-3 w-3 animate-spin" /> : "加速"}
                    </Button>
                  </div>
                </div>

                <div className="rounded-md border border-[#f59e0b]/20 bg-[#f59e0b]/5 px-3 py-2 text-[11px] text-[#f59e0b]/80">
                  {t("debug.timeWarning")}
                </div>
              </CardContent>
            </Card>

            {/* ==================== 直接设定偏移 + 数据库重置 ==================== */}
            <div className="flex flex-col gap-6">
              {/* 直接设定偏移（绝对） */}
              <Card className={`border-[#f59e0b]/30 ${timeLocked ? "opacity-60" : ""}`}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Target className="h-5 w-5 text-[#f59e0b]" />
                    {t("debug.directSetTitle")}
                  </CardTitle>
                  <CardDescription>{t("debug.directSetDesc")}</CardDescription>
                  {timeLocked && (
                    <CardDescription className="text-[#f59e0b]">
                      {t("debug.testModeDisabled")}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="偏移量"
                      value={directVal}
                      disabled={timeLocked}
                      onChange={(e) => setDirectVal(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleDirectSet()}
                      className="h-9 w-24 font-mono text-xs"
                    />
                    <div className="inline-flex h-9 overflow-hidden rounded-md border border-white/10 bg-black/40">
                      {OFFSET_UNITS.map((u) => (
                        <button
                          key={u.key}
                          type="button"
                          disabled={timeLocked}
                          onClick={() => setDirectUnit(u.key)}
                          className={`h-full px-3 text-xs font-medium transition-colors ${
                            directUnit === u.key
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
                      disabled={timeLocked || setting || !directVal}
                      onClick={() => { void handleDirectSet(); }}
                    >
                      {setting ? <Loader2 className="h-3 w-3 animate-spin" /> : "设定"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-white/40">
                    直接写入精确的时间偏移值（秒），替换当前偏移。
                  </p>
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
                    onClick={() => { void handleResetDb(); }}
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
          </div>
        )}
      </div>
    </AdminGuard>
  );
}
