"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, Calendar, ChevronLeft, ChevronRight, Loader2, Search, TrendingDown, TrendingUp, WalletCards } from "lucide-react";
import { AgentGuard } from "@/components/agent-guard";
import { AgentShell } from "@/components/agent/agent-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { cn, formatNumber, shortenAddress } from "@/lib/utils";
import type { AgentTeamTransaction, AgentTransaction, AgentTransactionSummary } from "@/components/agent/types";

type Direction = "all" | AgentTransaction["direction"];

const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "deposit", label: "入金" },
  { value: "withdraw", label: "出金" },
  { value: "spend", label: "操作" },
  { value: "credit", label: "收益" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "全部操作" },
  { value: "ai_order", label: "AI 套餐" },
  { value: "stake", label: "质押" },
  { value: "lottery", label: "彩票" },
  { value: "burn", label: "燃烧" },
  { value: "swap", label: "闪兑" },
  { value: "claim", label: "领取" },
  { value: "stock_dividend", label: "股票分红" },
];

const DIRECTION_LABEL: Record<AgentTransaction["direction"], string> = {
  deposit: "入金",
  withdraw: "出金",
  spend: "操作",
  credit: "收益",
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function dateValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDay(value: string): Date | null {
  const parts = value.split("-").map((item) => Number(item));
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function nextDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

function monthBounds(offset = 0): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { start: dateValue(start), end: dateValue(end) };
}

function todayBounds(): { start: string; end: string } {
  const today = dateValue(new Date());
  return { start: today, end: today };
}

function dateText(value: string): string {
  const date = localDay(value);
  if (!date) return "";
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function monthCells(month: Date): Array<Date | null> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const totalDays = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<Date | null> = [];
  for (let index = 0; index < first.getDay(); index++) cells.push(null);
  for (let day = 1; day <= totalDays; day++) cells.push(new Date(month.getFullYear(), month.getMonth(), day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function DatePickerButton({
  label,
  value,
  onChange,
  align = "left",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  align?: "left" | "right";
}) {
  const selected = localDay(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => selected ?? new Date());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) setMonth(selected);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const selectedValue = selected ? dateValue(selected) : "";
  const todayValue = dateValue(new Date());

  return (
    <div ref={rootRef} className="relative grid gap-1">
      <span className="text-[11px] text-white/40">{label}</span>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 w-[9.75rem] items-center justify-between gap-2 rounded-md border border-white/10 bg-black/40 px-3 text-left text-sm text-white transition hover:border-[#b829ff]/50 focus:outline-none focus:ring-2 focus:ring-[#b829ff]/40"
      >
        <span className={cn("tabular-nums", !value && "text-white/35")}>{value ? dateText(value) : "选择日期"}</span>
        <Calendar className="h-4 w-4 text-white/35" />
      </button>
      {open ? (
        <div
          className={cn(
            "absolute top-[4.35rem] z-50 w-72 rounded-lg border border-white/10 bg-[#080a0f] p-3 shadow-2xl shadow-black/50",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/65 hover:text-white"
              aria-label="上一月"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-bold text-white tabular-nums">{month.getFullYear()} 年 {month.getMonth() + 1} 月</div>
            <button
              type="button"
              onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/65 hover:text-white"
              aria-label="下一月"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-white/35">
            {["日", "一", "二", "三", "四", "五", "六"].map((item) => <div key={item} className="h-6 leading-6">{item}</div>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {monthCells(month).map((date, index) => {
              if (!date) return <div key={`empty-${index}`} className="h-8" />;
              const currentValue = dateValue(date);
              const selectedDay = currentValue === selectedValue;
              const today = currentValue === todayValue;
              return (
                <button
                  key={currentValue}
                  type="button"
                  onClick={() => {
                    onChange(currentValue);
                    setOpen(false);
                  }}
                  className={cn(
                    "h-8 rounded-md text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white",
                    today && "ring-1 ring-[#00c6ff]/45",
                    selectedDay && "bg-gradient-to-r from-[#00c6ff] to-[#b829ff] text-white shadow-[0_0_18px_rgba(184,41,255,0.25)]",
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ title, value, icon: Icon }: { title: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div>
          <div className="text-xs text-white/45">{title}</div>
          <div className="mt-1 text-lg font-black text-white">{value}</div>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5">
          <Icon className="h-4 w-4 text-[#00c6ff]" />
        </div>
      </CardContent>
    </Card>
  );
}

function TransactionsContent() {
  const defaultRange = useMemo(() => monthBounds(), []);
  const { jwt, signIn } = useSiweJwt();
  const [start, setStart] = useState(defaultRange.start);
  const [end, setEnd] = useState(defaultRange.end);
  const [keyword, setKeyword] = useState("");
  const [direction, setDirection] = useState<Direction>("all");
  const [type, setType] = useState("all");
  const [items, setItems] = useState<AgentTeamTransaction[]>([]);
  const [summary, setSummary] = useState<AgentTransactionSummary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const buildQuery = useCallback((cursor?: string | null) => {
    const params = new URLSearchParams();
    params.set("limit", "100");
    if (cursor) params.set("cursor", cursor);
    const startDate = localDay(start);
    const endDate = localDay(end);
    if (startDate) params.set("from", String(seconds(startDate)));
    if (endDate) params.set("to", String(seconds(nextDay(endDate))));
    if (keyword.trim()) params.set("q", keyword.trim());
    if (direction !== "all") params.set("direction", direction);
    if (type !== "all") params.set("type", type);
    return params.toString();
  }, [direction, end, keyword, start, type]);

  const load = useCallback(async (cursor: string | null = null, append = false) => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const resp = await api.get<{
        items: AgentTeamTransaction[];
        summary: AgentTransactionSummary;
        nextCursor: string | null;
      }>(`${endpoints.agentTransactions}?${buildQuery(cursor)}`, token);
      setItems((current) => append ? [...current, ...(resp.items ?? [])] : resp.items ?? []);
      setSummary(resp.summary);
      setNextCursor(resp.nextCursor ?? null);
    } finally {
      setLoading(false);
    }
  }, [buildQuery, jwt, signIn]);

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const setQuickRange = (range: { start: string; end: string }) => {
    setStart(range.start);
    setEnd(range.end);
  };

  const clearRange = () => {
    setStart("");
    setEnd("");
  };
  const totalIn = Number(summary?.totalInUsdt ?? 0);
  const totalOut = Number(summary?.totalOutUsdt ?? 0);
  const netIn = totalIn - totalOut;

  return (
    <AgentShell>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="记录数" value={`${summary?.count ?? 0} 条`} icon={Activity} />
        <StatCard title="下级入金" value={`${formatNumber(totalIn, 2)} U`} icon={TrendingUp} />
        <StatCard title="下级出金" value={`${formatNumber(totalOut, 2)} U`} icon={TrendingDown} />
        <StatCard title="入金 - 出金" value={`${formatNumber(netIn, 2)} U`} icon={WalletCards} />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>下级流水查询</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button variant={!start && !end ? "default" : "outline"} size="sm" onClick={clearRange}>全部</Button>
            <Button variant="outline" size="sm" onClick={() => setQuickRange(todayBounds())}>今天</Button>
            <Button variant="outline" size="sm" onClick={() => setQuickRange(monthBounds())}>本月</Button>
            <Button variant="outline" size="sm" onClick={() => setQuickRange(monthBounds(-1))}>上月</Button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <DatePickerButton label="开始日期" value={start} onChange={setStart} />
            <DatePickerButton label="结束日期" value={end} onChange={setEnd} align="right" />
            <div className="relative min-w-[14rem] flex-1">
              <span className="mb-1 block text-[11px] text-white/40">搜索用户</span>
              <Search className="pointer-events-none absolute left-3 top-[2.15rem] h-4 w-4 text-white/30" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void load(null, false);
                }}
                placeholder="钱包地址、邀请码或上级地址"
                className="h-9 pl-9"
              />
            </div>
            <Button size="sm" onClick={() => void load(null, false)}>查询</Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {DIRECTION_OPTIONS.map((item) => (
              <Button key={item.value} variant={direction === item.value ? "default" : "outline"} size="sm" onClick={() => setDirection(item.value)}>
                {item.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {TYPE_OPTIONS.map((item) => (
              <Button key={item.value} variant={type === item.value ? "default" : "outline"} size="sm" onClick={() => setType(item.value)}>
                {item.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardContent className="pt-4">
          {loading && items.length === 0 ? (
            <Loader2 className="mx-auto my-12 h-6 w-6 animate-spin text-white/40" />
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-sm text-white/40">暂无流水</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-white/40">
                      <th className="px-3 py-3">时间</th>
                      <th className="px-3 py-3">用户</th>
                      <th className="px-3 py-3">层级</th>
                      <th className="px-3 py-3">操作</th>
                      <th className="px-3 py-3">方向</th>
                      <th className="px-3 py-3">数量</th>
                      <th className="px-3 py-3 text-right">折合 U</th>
                      <th className="px-3 py-3 text-right">凭证</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((tx) => (
                      <tr key={`${tx.id}:${tx.user}`} className="border-b border-white/5 hover:bg-white/[0.03]">
                        <td className="px-3 py-3 text-xs text-white/45">{tx.occurredAt ? new Date(tx.occurredAt * 1000).toLocaleString() : "-"}</td>
                        <td className="px-3 py-3">
                          <Link href={`/agent/users/${tx.user}`} className="font-mono text-xs text-white/75 hover:text-white">
                            {shortenAddress(tx.user, 6)}
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-white/55">{tx.generation} 代</td>
                        <td className="px-3 py-3 text-white/80">{tx.label}</td>
                        <td className="px-3 py-3">
                          <span className={cn(
                            "rounded border px-2 py-1 text-xs",
                            tx.direction === "deposit" ? "border-green-400/25 bg-green-400/10 text-green-300" :
                            tx.direction === "withdraw" ? "border-amber-400/25 bg-amber-400/10 text-amber-300" :
                            tx.direction === "spend" ? "border-red-400/25 bg-red-400/10 text-red-300" :
                            "border-sky-400/25 bg-sky-400/10 text-sky-300",
                          )}>{DIRECTION_LABEL[tx.direction]}</span>
                        </td>
                        <td className="px-3 py-3 text-white/60">{tx.amount}</td>
                        <td className="px-3 py-3 text-right">{formatNumber(Number(tx.usdtValue), 2)}</td>
                        <td className="px-3 py-3 text-right font-mono text-xs text-white/40">{tx.sourceRef ? shortenAddress(tx.sourceRef, 6) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {nextCursor ? (
                <div className="mt-4 flex justify-center">
                  <Button variant="outline" onClick={() => void load(nextCursor, true)} disabled={loading}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "加载更多"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </AgentShell>
  );
}

export default function AgentTransactionsPage() {
  return (
    <AgentGuard>
      <TransactionsContent />
    </AgentGuard>
  );
}
