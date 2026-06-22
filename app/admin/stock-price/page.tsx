"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, Coins, ChevronLeft, RefreshCw, Power, PowerOff } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";

type StockQuoteMode = "auto" | "manual";
type StockMarketMode = "auto" | "manual";
type StockMarketClosedReason = "open" | "weekend" | "manual";

interface StockMarketStatus {
  mode: StockMarketMode;
  manualClosed: boolean;
  autoClosed: boolean;
  closed: boolean;
  reason: StockMarketClosedReason;
  tradePaused: boolean;
}

interface StockQuoteResponse {
  symbol: string;
  name: string;
  priceUsdt: number;
  source: string;
  updatedAt: number | null;
  syncedAt: number | null;
  fallback: boolean;
  mode: StockQuoteMode;
  tradePaused: boolean;
  marketClosed?: boolean;
  marketMode?: StockMarketMode;
  manualClosed?: boolean;
  autoClosed?: boolean;
  marketClosedReason?: StockMarketClosedReason;
  market?: StockMarketStatus;
}

interface StockQuoteSyncResponse {
  synced: boolean;
  reason: "ok" | "manual" | "fresh" | "fetch_failed";
  quote: StockQuoteResponse;
}

interface StockMarketUpdateResponse {
  paused?: boolean;
  tradePaused?: boolean;
  marketClosed: boolean;
  marketMode: StockMarketMode;
  manualClosed: boolean;
  autoClosed: boolean;
  marketClosedReason: StockMarketClosedReason;
  market: StockMarketStatus;
}

export default function AdminStockPricePage() {
  const { jwt, signIn } = useSiweJwt();
  const [price, setPrice] = useState("");
  const [priceMode, setPriceMode] = useState<StockQuoteMode>("auto");
  const [quote, setQuote] = useState<StockQuoteResponse | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingMarket, setSavingMarket] = useState(false);

  const applyQuote = useCallback((next: StockQuoteResponse) => {
    setQuote(next);
    setPrice(String(next.priceUsdt));
    setPriceMode(next.mode);
    setUpdatedAt(next.syncedAt ?? next.updatedAt);
  }, []);

  const mergeMarket = useCallback((next: StockMarketUpdateResponse) => {
    setQuote((current) => current
      ? {
          ...current,
          tradePaused: next.tradePaused ?? next.paused ?? next.marketClosed,
          marketClosed: next.marketClosed,
          marketMode: next.marketMode,
          manualClosed: next.manualClosed,
          autoClosed: next.autoClosed,
          marketClosedReason: next.marketClosedReason,
          market: next.market,
        }
      : current);
  }, []);

  const refresh = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<StockQuoteResponse>(endpoints.adminStockPrice, token);
      applyQuote(r);
    } finally {
      setLoading(false);
    }
  }, [applyQuote, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      const r = await api.post<StockQuoteResponse>(endpoints.adminStockPrice, { priceUsdt: num }, token);
      applyQuote(r);
      await Swal.fire({
        icon: "success",
        title: "保存成功",
        text: "手动兜底价已更新",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "保存失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  const changeMode = async (nextMode: StockQuoteMode) => {
    const token = jwt ?? (await signIn());
    if (!token || nextMode === priceMode) return;
    setSaving(true);
    try {
      const r = await api.post<StockQuoteResponse>(endpoints.adminStockPriceMode, { mode: nextMode }, token);
      applyQuote(r);
      await Swal.fire({
        icon: "success",
        title: nextMode === "auto" ? "已开启自动同步" : "已切换为手动模式",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "切换失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  const changeMarketMode = async (nextMode: StockMarketMode) => {
    const token = jwt ?? (await signIn());
    const currentMode = quote?.marketMode ?? quote?.market?.mode ?? "auto";
    if (!token || nextMode === currentMode) return;
    setSavingMarket(true);
    try {
      const r = await api.post<StockMarketUpdateResponse>(endpoints.adminStockTrade, { mode: nextMode }, token);
      mergeMarket(r);
      await Swal.fire({
        icon: "success",
        title: nextMode === "auto" ? "已切换为自动休市" : "已切换为手动控制",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "切换失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSavingMarket(false);
    }
  };

  const syncNow = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSyncing(true);
    try {
      const r = await api.post<StockQuoteSyncResponse>(endpoints.adminStockPriceSync, {}, token);
      applyQuote(r.quote);
      await Swal.fire({
        icon: r.synced ? "success" : "warning",
        title: r.synced ? "同步成功" : "同步未完成",
        text: r.synced ? `WTO 当前价格 $${formatNumber(r.quote.priceUsdt, 4)}` : "行情源暂时不可用，继续使用当前价格",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "同步失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSyncing(false);
    }
  };

  const toggleMarketClosed = async () => {
    const token = jwt ?? (await signIn());
    if (!token || !quote) return;
    const manualClosed = quote.manualClosed ?? quote.market?.manualClosed ?? false;
    const nextClosed = !manualClosed;
    const confirmed = await Swal.fire({
      icon: nextClosed ? "warning" : "question",
      title: nextClosed ? "手动休市？" : "手动开市？",
      text: nextClosed ? "休市后用户不能买入或卖出 WTO，且当天不会生成新的每日股票分红" : "开市后用户可继续买卖 WTO，后续每日分红按计划结算",
      showCancelButton: true,
      confirmButtonText: nextClosed ? "确认休市" : "确认开市",
      cancelButtonText: "取消",
      confirmButtonColor: nextClosed ? "#ef4444" : "#b829ff",
      background: "#141419",
      color: "#fff",
    });
    if (!confirmed.isConfirmed) return;
    setSavingMarket(true);
    try {
      const r = await api.post<StockMarketUpdateResponse>(endpoints.adminStockTrade, { manualClosed: nextClosed }, token);
      mergeMarket(r);
      await Swal.fire({
        icon: "success",
        title: r.marketClosed ? "市场已休市" : "市场已开市",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "操作失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSavingMarket(false);
    }
  };

  const marketClosed = Boolean(quote?.marketClosed ?? quote?.tradePaused);
  const marketMode = quote?.marketMode ?? quote?.market?.mode ?? "auto";
  const manualClosed = Boolean(quote?.manualClosed ?? quote?.market?.manualClosed);
  const marketText = marketClosed ? "市场休市中" : "市场开市中";
  const marketHint = marketMode === "auto"
    ? marketClosed
      ? "自动模式：周末休市，不开放闪兑与当日分红"
      : "自动模式：工作日开市，周末自动休市"
    : marketClosed
      ? "手动模式：当前休市，不开放闪兑与当日分红"
      : "手动模式：当前开市，后台可随时休市";

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
          WTO 股价用于套餐赠股、HS 闪兑和每日分红折算
        </p>

        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>WTO 股价</CardTitle>
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
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-white/5 bg-black/30 p-2 text-sm">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-white/35">当前价格</div>
                    <div className="mt-1 text-xl font-black text-white">${formatNumber(quote?.priceUsdt ?? Number(price || 0), 4)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-white/35">来源</div>
                    <div className="mt-1 text-sm font-bold text-white/80">{quote?.source ?? "manual"}</div>
                    <div className="mt-0.5 text-[11px] text-white/40">{quote?.fallback ? "兜底价" : "实时行情"}</div>
                  </div>
                </div>

                <div className={`rounded-lg border p-3 ${marketClosed ? "border-red-400/25 bg-red-400/10" : "border-green-400/20 bg-green-400/10"}`}>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className={`text-sm font-bold ${marketClosed ? "text-red-300" : "text-green-300"}`}>
                          {marketText}
                        </div>
                        <div className="mt-0.5 text-[11px] text-white/45">
                          {marketHint}
                        </div>
                      </div>
                      {marketMode === "manual" && (
                        <Button onClick={toggleMarketClosed} disabled={savingMarket || !quote} variant={manualClosed ? "outline" : "danger"} size="sm">
                          {savingMarket ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : manualClosed ? (
                            <Power className="h-4 w-4" />
                          ) : (
                            <PowerOff className="h-4 w-4" />
                          )}
                          {manualClosed ? "开市" : "休市"}
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 rounded-md border border-white/5 bg-black/30 p-1">
                      {(["auto", "manual"] as const).map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => void changeMarketMode(item)}
                          disabled={savingMarket}
                          className={cn(
                            "h-8 rounded text-xs font-bold transition disabled:opacity-60",
                            marketMode === item ? "bg-white/10 text-white ring-1 ring-white/15" : "text-white/45 hover:bg-white/5",
                          )}
                        >
                          {item === "auto" ? "自动周末休市" : "手动控制"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-white/70">同步模式</label>
                  <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-white/5 bg-black/30 p-1">
                    {(["auto", "manual"] as const).map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => void changeMode(item)}
                        disabled={saving}
                        className={cn(
                          "h-9 rounded-md text-sm font-bold transition disabled:opacity-60",
                          priceMode === item ? "bg-[#b829ff]/25 text-white ring-1 ring-[#b829ff]/40" : "text-white/45 hover:bg-white/5",
                        )}
                      >
                        {item === "auto" ? "自动同步" : "手动模式"}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-white/70">手动兜底价</label>
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
                <div className="flex justify-end gap-2">
                  <Button onClick={syncNow} disabled={syncing} variant="outline">
                    {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    立即同步
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存兜底价
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
