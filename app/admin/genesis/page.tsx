"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Type,
  Upload,
  Users,
} from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, endpoints } from "@/lib/api";
import { AI_TIERS, type AiTierKey } from "@/lib/constants/business-rules";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { cn, formatNumber, shortenAddress } from "@/lib/utils";

type Tier = AiTierKey;

interface ParsedRow {
  address: string;
  tier: Tier;
  referrer?: string | null;
}

interface NodeParticipant {
  record_id: string;
  address: string;
  tier: Tier;
  referrer: string | null;
  order_count: number;
  latest_at: number;
}

interface TierCount {
  tier: Tier;
  user_count: number;
  order_count: number;
}

interface NodeListResponse {
  counts: TierCount[];
  items: NodeParticipant[];
}

const PAGE_SIZE = 10;
const EMPTY_PARTICIPANTS = (): Record<Tier, NodeParticipant[]> => ({
  genesis: [],
  glory: [],
  eternal: [],
  shine: [],
  pioneer: [],
});
const EMPTY_COUNTS = (): Record<Tier, TierCount> => ({
  genesis: { tier: "genesis", user_count: 0, order_count: 0 },
  glory: { tier: "glory", user_count: 0, order_count: 0 },
  eternal: { tier: "eternal", user_count: 0, order_count: 0 },
  shine: { tier: "shine", user_count: 0, order_count: 0 },
  pioneer: { tier: "pioneer", user_count: 0, order_count: 0 },
});
const TIER_LABELS: Record<Tier, string> = {
  genesis: "创世",
  glory: "荣耀",
  eternal: "永恒",
  shine: "鑫耀",
  pioneer: "开拓者",
};
const TIER_VISUALS: Record<Tier, { dot: string; badge: string; amount: string }> = {
  genesis: {
    dot: "bg-amber-300 shadow-[0_0_14px_rgba(252,211,77,0.65)]",
    badge: "border-amber-300/20 bg-amber-300/10 text-amber-200",
    amount: "text-amber-200",
  },
  glory: {
    dot: "bg-fuchsia-400 shadow-[0_0_14px_rgba(232,121,249,0.55)]",
    badge: "border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200",
    amount: "text-fuchsia-200",
  },
  eternal: {
    dot: "bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.55)]",
    badge: "border-cyan-400/20 bg-cyan-400/10 text-cyan-200",
    amount: "text-cyan-200",
  },
  shine: {
    dot: "bg-violet-400 shadow-[0_0_14px_rgba(167,139,250,0.55)]",
    badge: "border-violet-400/20 bg-violet-400/10 text-violet-200",
    amount: "text-violet-200",
  },
  pioneer: {
    dot: "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.5)]",
    badge: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
    amount: "text-emerald-200",
  },
};
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CSV_SEPARATOR_RE = /[,，]/;
const TIER_ALIASES: Record<string, Tier> = {
  genesis: "genesis",
  founder: "genesis",
  "5000": "genesis",
  "5000u": "genesis",
  创世: "genesis",
  创世节点: "genesis",
  创世5000: "genesis",
  创世5000u: "genesis",
  glory: "glory",
  "2000": "glory",
  "2000u": "glory",
  荣耀: "glory",
  荣耀2000: "glory",
  荣耀2000u: "glory",
  eternal: "eternal",
  "1000": "eternal",
  "1000u": "eternal",
  永恒: "eternal",
  永恒1000: "eternal",
  永恒1000u: "eternal",
  shine: "shine",
  "500": "shine",
  "500u": "shine",
  鑫耀: "shine",
  星耀: "shine",
  鑫耀500: "shine",
  鑫耀500u: "shine",
  星耀500: "shine",
  星耀500u: "shine",
  pioneer: "pioneer",
  "100": "pioneer",
  "100u": "pioneer",
  开拓者: "pioneer",
  开拓者100: "pioneer",
  开拓者100u: "pioneer",
};

function normalizeTier(value: string): Tier | null {
  return TIER_ALIASES[value.trim().toLowerCase().replace(/\s+/g, "")] ?? null;
}

function dateText(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function parseLines(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out: ParsedRow[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const [a, tierCell, referrerCell] = line.split(CSV_SEPARATOR_RE).map((cell) => cell.trim());
    if (!a || !tierCell || !ADDRESS_RE.test(a)) continue;
    const address = a.toLowerCase();
    if (seen.has(address)) continue;

    const tier = normalizeTier(tierCell);
    if (!tier) continue;

    let referrer: string | null = null;
    if (referrerCell) {
      if (!ADDRESS_RE.test(referrerCell) || referrerCell.toLowerCase() === address) continue;
      referrer = referrerCell.toLowerCase();
    }

    seen.add(address);
    out.push({ address, tier, referrer });
  }
  return out;
}

function groupParticipants(items: NodeParticipant[]): Record<Tier, NodeParticipant[]> {
  const grouped = EMPTY_PARTICIPANTS();
  for (const item of items) grouped[item.tier]?.push(item);
  return grouped;
}

function mapCounts(items: TierCount[]): Record<Tier, TierCount> {
  const counts = EMPTY_COUNTS();
  for (const item of items) counts[item.tier] = item;
  return counts;
}

export default function AdminGenesisPage() {
  const { jwt, signIn } = useSiweJwt();
  const [text, setText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [participants, setParticipants] = useState<Record<Tier, NodeParticipant[]>>(EMPTY_PARTICIPANTS);
  const [counts, setCounts] = useState<Record<Tier, TierCount>>(EMPTY_COUNTS);
  const [expandedTier, setExpandedTier] = useState<Tier | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [loadingMore, setLoadingMore] = useState<Tier | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const refreshSequence = useRef(0);

  const rows = useMemo(() => parseLines(text), [text]);
  const totalUsers = AI_TIERS.reduce((total, tier) => total + counts[tier.key].user_count, 0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const refreshNodes = useCallback(async (query: string) => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    const sequence = ++refreshSequence.current;
    setLoadingNodes(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      const response = await api.get<NodeListResponse>(`${endpoints.adminGenesisNodes}?${params}`, token);
      if (sequence !== refreshSequence.current) return;
      const nextParticipants = groupParticipants(response.items ?? []);
      const nextCounts = mapCounts(response.counts ?? []);
      setParticipants(nextParticipants);
      setCounts(nextCounts);
      if (query) {
        setExpandedTier(AI_TIERS.find((tier) => nextCounts[tier.key].user_count > 0)?.key ?? null);
      }
    } catch {
      if (sequence !== refreshSequence.current) return;
      setParticipants(EMPTY_PARTICIPANTS());
      setCounts(EMPTY_COUNTS());
    } finally {
      if (sequence === refreshSequence.current) setLoadingNodes(false);
    }
  }, [jwt, signIn]);

  useEffect(() => {
    void refreshNodes(debouncedSearch);
  }, [debouncedSearch, refreshNodes]);

  const loadMore = async (tier: Tier) => {
    const token = jwt ?? (await signIn());
    if (!token || loadingMore) return;
    setLoadingMore(tier);
    try {
      const params = new URLSearchParams({
        tier,
        offset: String(participants[tier].length),
        limit: String(PAGE_SIZE),
      });
      if (debouncedSearch) params.set("q", debouncedSearch);
      const response = await api.get<NodeListResponse>(`${endpoints.adminGenesisNodes}?${params}`, token);
      setParticipants((current) => {
        const known = new Set(current[tier].map((item) => item.record_id));
        return { ...current, [tier]: [...current[tier], ...response.items.filter((item) => !known.has(item.record_id))] };
      });
    } catch {
      // 保留已加载的名单，用户可以再次点击加载。
    } finally {
      setLoadingMore(null);
    }
  };

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(address);
      window.setTimeout(() => setCopiedAddress((current) => current === address ? null : current), 1200);
    } catch {
      setCopiedAddress(null);
    }
  };

  const onFile = async (file: File) => {
    setText(await file.text());
  };

  const upload = async () => {
    if (rows.length === 0) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setImporting(true);
    try {
      const result = await api.post<{ inserted: number; skipped: number; ordersCreated?: number; referrersBound?: number }>(
        endpoints.adminGenesisImport,
        { rows },
        token,
      );
      await Swal.fire({
        icon: "success",
        title: "导入完成",
        text: `新增 ${result.inserted} 条，跳过 ${result.skipped} 条（已存在），创建权益订单 ${result.ordersCreated ?? 0} 条，绑定推荐人 ${result.referrersBound ?? 0} 条`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      setText("");
      setShowImport(false);
      await refreshNodes(debouncedSearch);
    } catch (error) {
      await Swal.fire({
        icon: "error",
        title: "导入失败",
        text: (error as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 transition-colors hover:text-white/70">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>

        <div className="flex max-w-5xl flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-black">
              <Database className="h-6 w-6 text-[#00c6ff]" /> 节点名单
            </h1>
            <p className="mt-1 text-sm text-white/50">按套餐等级查看参与钱包</p>
          </div>
          <Button variant="outline" onClick={() => setShowImport((visible) => !visible)}>
            <Upload className="h-4 w-4" />
            {showImport ? "收起导入" : "导入名单"}
          </Button>
        </div>

        {showImport && (
          <Card className="mt-6 max-w-5xl border-[#b829ff]/15">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Type className="h-5 w-5 text-[#00c6ff]" />
                录入名单
              </CardTitle>
              <p className="text-xs text-white/40">
                每行填写 <code className="ml-1 text-[#b829ff]">0x地址,等级</code>，可在第三列填写推荐人地址。等级支持中文或英文。
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={`0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb，创世\n0xcccccccccccccccccccccccccccccccccccccccc，荣耀，0x1111111111111111111111111111111111111111`}
                rows={7}
                className="block w-full rounded-md border border-white/10 bg-black/30 p-3 font-mono text-xs text-white/80 outline-none focus:border-[#b829ff]"
              />

              <div className="flex flex-wrap items-center gap-3 text-xs text-white/40">
                <span>或上传 CSV：</span>
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void onFile(file);
                  }}
                  className="block min-w-0 flex-1 text-xs text-white/70 file:mr-3 file:rounded-md file:border-0 file:bg-[#b829ff]/20 file:px-3 file:py-1.5 file:text-[#b829ff] hover:file:bg-[#b829ff]/30"
                />
              </div>

              {rows.length > 0 && (
                <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs">
                  <div className="font-bold text-white/70">已解析 {rows.length} 条有效记录</div>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-white/50">
                    {rows.slice(0, 50).map((row) => (
                      <li key={row.address} className="font-mono">
                        {shortenAddress(row.address, 7)}
                        <span className="ml-2 text-[#00c6ff]">[{TIER_LABELS[row.tier]}]</span>
                        {row.referrer && <span className="ml-2 text-white/35">推荐人 {shortenAddress(row.referrer, 7)}</span>}
                      </li>
                    ))}
                    {rows.length > 50 && <li className="text-white/30">还有 {rows.length - 50} 条</li>}
                  </ul>
                </div>
              )}

              <Button onClick={upload} disabled={importing || rows.length === 0} className="sm:self-start">
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                确认导入 {rows.length > 0 && `(${rows.length})`}
              </Button>
            </CardContent>
          </Card>
        )}

        <Card className="mt-6 max-w-5xl overflow-hidden">
          <CardHeader className="gap-4 pb-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-[#00c6ff]" />
                套餐节点
              </CardTitle>
              <Button onClick={() => refreshNodes(debouncedSearch)} disabled={loadingNodes} variant="ghost" size="sm">
                {loadingNodes ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                刷新
              </Button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索钱包地址"
                className="pl-9"
              />
            </div>
          </CardHeader>

          <CardContent className="px-3 pb-4 pt-0 sm:px-6">
            {loadingNodes ? (
              <div className="flex items-center justify-center py-16 text-white/40">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : totalUsers === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-12 text-center text-sm text-white/45">
                {debouncedSearch ? "没有找到这个钱包" : "暂无节点记录"}
              </div>
            ) : (
              <div className="space-y-2">
                {AI_TIERS.map((tierMeta) => {
                  const tier = tierMeta.key;
                  const count = counts[tier];
                  const items = participants[tier];
                  const isExpanded = expandedTier === tier;
                  const visual = TIER_VISUALS[tier];
                  const hiddenCount = Math.max(0, count.user_count - items.length);
                  return (
                    <section key={tier} className="overflow-hidden rounded-xl border border-white/[0.07] bg-black/20">
                      <button
                        type="button"
                        onClick={() => setExpandedTier((current) => current === tier ? null : tier)}
                        className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-white/[0.035]"
                        aria-expanded={isExpanded}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", visual.dot)} />
                          <span className="font-bold text-white">{tierMeta.label}</span>
                          <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", visual.badge)}>
                            {count.user_count}人
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="hidden text-xs text-white/35 sm:inline">{formatNumber(tierMeta.usdt, 0)}U 套餐</span>
                          {isExpanded ? <ChevronDown className="h-4 w-4 text-white/45" /> : <ChevronRight className="h-4 w-4 text-white/45" />}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="border-t border-white/[0.07]">
                          {items.length === 0 ? (
                            <div className="px-4 py-8 text-center text-xs text-white/35">该等级暂无节点</div>
                          ) : (
                            <div className="divide-y divide-white/[0.05]">
                              {items.map((item) => (
                                <div key={item.record_id} className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                  <div className="min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => void copyAddress(item.address)}
                                      title={item.address}
                                      className="group inline-flex max-w-full items-center gap-2 font-mono text-sm text-white/75 hover:text-white"
                                    >
                                      <span className="truncate">{shortenAddress(item.address, 9)}</span>
                                      {copiedAddress === item.address
                                        ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                                        : <Copy className="h-3.5 w-3.5 shrink-0 text-white/25 group-hover:text-white/55" />}
                                    </button>
                                    <div className="mt-1 text-xs text-white/30">
                                      推荐人：{item.referrer ? shortenAddress(item.referrer, 7) : "无"}
                                    </div>
                                  </div>
                                  <div className="flex items-end justify-between gap-4 sm:block sm:text-right">
                                    <div className={cn("text-sm font-semibold", visual.amount)}>
                                      {item.order_count > 0
                                        ? `${item.order_count}份 · ${formatNumber(item.order_count * tierMeta.usdt, 0)}U`
                                        : "待创建权益"}
                                    </div>
                                    <div className="mt-1 text-xs text-white/30">{dateText(item.latest_at)}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {hiddenCount > 0 && (
                            <div className="border-t border-white/[0.06] p-3 text-center">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void loadMore(tier)}
                                disabled={loadingMore === tier}
                                className="text-white/55 hover:text-white"
                              >
                                {loadingMore === tier && <Loader2 className="h-4 w-4 animate-spin" />}
                                再显示 {Math.min(PAGE_SIZE, hiddenCount)} 人
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}
