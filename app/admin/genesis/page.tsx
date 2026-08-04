"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Upload, ChevronLeft, Database, Type, RefreshCw, Users } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { cn, formatNumber, shortenAddress } from "@/lib/utils";

interface ParsedRow {
  address: string;
  tier: Tier;
  referrer?: string | null;
}

interface GenesisNode {
  record_id: string;
  address: string;
  tier: Tier;
  source: "csv" | "onchain-scan" | "dapp" | string;
  imported_at: number;
  imported_by: string;
  referrer: string | null;
  order_id: string | null;
  usdt_in: string | null;
  stock_granted: string | null;
}

type Tier = "genesis" | "glory" | "eternal" | "shine" | "pioneer";
const TIER_LABELS: Record<string, string> = {
  genesis: "创世",
  glory: "荣耀",
  eternal: "永恒",
  shine: "鑫耀",
  pioneer: "开拓者",
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

function weiToNumber(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  return Number(BigInt(value)) / 1e18;
}

function parseLines(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out: ParsedRow[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const [a, tierCell, referrerCell] = line.split(CSV_SEPARATOR_RE).map((s) => s.trim());
    if (!a || !tierCell || !ADDRESS_RE.test(a)) continue;
    const addr = a.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);

    const tier = normalizeTier(tierCell);
    if (!tier) continue;

    let referrer: string | null = null;
    if (referrerCell) {
      if (!ADDRESS_RE.test(referrerCell) || referrerCell.toLowerCase() === addr) continue;
      referrer = referrerCell.toLowerCase();
    }

    out.push({ address: addr, tier, referrer });
  }
  return out;
}

export default function AdminGenesisPage() {
  const { jwt, signIn } = useSiweJwt();
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [nodes, setNodes] = useState<GenesisNode[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);

  const rows = useMemo(() => parseLines(text), [text]);

  const refreshNodes = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoadingNodes(true);
    try {
      const r = await api.get<{ items: GenesisNode[] }>(endpoints.adminGenesisNodes, token);
      setNodes(r.items ?? []);
    } catch {
      setNodes([]);
    } finally {
      setLoadingNodes(false);
    }
  }, [jwt, signIn]);

  useEffect(() => {
    void refreshNodes();
  }, [refreshNodes]);

  const onFile = async (file: File) => {
    setText(await file.text());
  };

  const upload = async () => {
    if (rows.length === 0) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setImporting(true);
    try {
      const r = await api.post<{ inserted: number; skipped: number; ordersCreated?: number; referrersBound?: number }>(
        endpoints.adminGenesisImport,
        { rows },
        token,
      );
      await Swal.fire({
        icon: "success",
        title: "导入完成",
        text: `新增 ${r.inserted} 条，跳过 ${r.skipped} 条（已存在），创建权益订单 ${r.ordersCreated ?? 0} 条，绑定推荐人 ${r.referrersBound ?? 0} 条`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      setText("");
      await refreshNodes();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "导入失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setImporting(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Database className="h-6 w-6 text-[#00c6ff]" /> 创世节点
        </h1>
        <p className="mt-1 text-sm text-white/50">
          导入和管理创世用户名单
        </p>

        <Card className="mt-8 max-w-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Type className="h-5 w-5 text-[#00c6ff]" />
              录入名单
            </CardTitle>
            <p className="text-xs text-white/40">
              支持手动粘贴或上传 CSV。每行格式：
              <code className="text-[#b829ff] ml-1">0x地址,等级</code> 或
              <code className="text-[#b829ff] ml-1">0x地址，等级，推荐人地址</code>
              。等级支持中文/英文，推荐人可选。
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb，创世\n0xcccccccccccccccccccccccccccccccccccccccc，荣耀，0x1111111111111111111111111111111111111111\n0xdddddddddddddddddddddddddddddddddddddddd,eternal,0x2222222222222222222222222222222222222222`}
              rows={8}
              className="block w-full rounded-md border border-white/10 bg-black/30 p-3 font-mono text-xs text-white/80 outline-none focus:border-[#b829ff]"
            />

            <div className="flex items-center gap-3 text-xs text-white/40">
              <span>或上传 CSV：</span>
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
                className="block flex-1 text-xs text-white/70 file:mr-3 file:rounded-md file:border-0 file:bg-[#b829ff]/20 file:px-3 file:py-1.5 file:text-[#b829ff] hover:file:bg-[#b829ff]/30"
              />
            </div>

            {rows.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs">
                <div className="font-bold text-white/70">已解析 {rows.length} 条有效记录</div>
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-white/50">
                  {rows.slice(0, 50).map((r) => (
                    <li key={r.address} className="font-mono">
                      {r.address.slice(0, 10)}...{r.address.slice(-6)}
                      <span className="ml-2 text-[#00c6ff]">[{TIER_LABELS[r.tier] ?? r.tier}]</span>
                      {r.referrer && (
                        <span className="ml-2 text-white/35">推荐人 {r.referrer.slice(0, 10)}...{r.referrer.slice(-6)}</span>
                      )}
                    </li>
                  ))}
                  {rows.length > 50 && <li className="text-white/30">...还有 {rows.length - 50} 条</li>}
                </ul>
              </div>
            )}

            <Button onClick={upload} disabled={importing || rows.length === 0}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              确认导入 {rows.length > 0 && `(${rows.length})`}
            </Button>
          </CardContent>
        </Card>

        <Card className="mt-8 max-w-5xl">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-[#00c6ff]" />
                当前创世节点名单
              </CardTitle>
              <Button onClick={refreshNodes} disabled={loadingNodes} variant="outline" size="sm">
                {loadingNodes ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingNodes ? (
              <div className="flex items-center justify-center py-10 text-white/40">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : nodes.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-black/30 px-4 py-8 text-center text-sm text-white/45">
                暂无创世节点记录
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-xs">
                  <thead className="border-b border-white/10 text-white/45">
                    <tr>
                      <th className="px-3 py-2 font-medium">地址</th>
                      <th className="px-3 py-2 font-medium">等级</th>
                      <th className="px-3 py-2 font-medium">推荐人</th>
                      <th className="px-3 py-2 font-medium">权益订单</th>
                      <th className="px-3 py-2 text-right font-medium">购买/导入时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.map((node) => {
                      const stock = weiToNumber(node.stock_granted);
                      return (
                        <tr key={node.record_id} className="border-b border-white/5 hover:bg-white/[0.03]">
                          <td className="px-3 py-3 font-mono text-white/75">{shortenAddress(node.address, 6)}</td>
                          <td className="px-3 py-3">
                            <span className="rounded-md border border-[#00c6ff]/20 bg-[#00c6ff]/10 px-2 py-1 text-[#00c6ff]">
                              {TIER_LABELS[node.tier] ?? node.tier}
                            </span>
                          </td>
                          <td className="px-3 py-3 font-mono text-white/50">
                            {node.referrer ? shortenAddress(node.referrer, 6) : "-"}
                          </td>
                          <td className="px-3 py-3">
                            <span className={cn(
                              "rounded-md px-2 py-1",
                              node.order_id
                                ? "border border-green-400/20 bg-green-400/10 text-green-300"
                                : "border border-amber-400/20 bg-amber-400/10 text-amber-300",
                            )}>
                              {node.order_id ? `已创建 · ${formatNumber(stock, 2)} 股` : "未创建"}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right text-white/45">{dateText(node.imported_at)}</td>
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
