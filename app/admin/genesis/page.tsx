"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Upload, ChevronLeft, Database, Type } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";

interface ParsedRow {
  address: string;
  tier: string;
}

const TIER_CHOICES = ["genesis", "glory", "eternal", "shine", "pioneer"] as const;
type Tier = (typeof TIER_CHOICES)[number];
const TIER_LABELS: Record<string, string> = {
  genesis: "创世",
  glory: "荣耀",
  eternal: "永恒",
  shine: "鑫耀",
  pioneer: "开拓者",
};

function parseLines(text: string, fallbackTier: Tier): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out: ParsedRow[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const [a, t] = line.split(",").map((s) => s.trim());
    if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) continue;
    const addr = a.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    const tier = TIER_CHOICES.find((x) => x === t) ?? fallbackTier;
    out.push({ address: addr, tier });
  }
  return out;
}

export default function AdminGenesisPage() {
  const { jwt, signIn } = useSiweJwt();
  const [text, setText] = useState("");
  const [defaultTier, setDefaultTier] = useState<Tier>("genesis");
  const [importing, setImporting] = useState(false);

  const rows = useMemo(() => parseLines(text, defaultTier), [text, defaultTier]);

  const onFile = async (file: File) => {
    setText(await file.text());
  };

  const upload = async () => {
    if (rows.length === 0) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setImporting(true);
    try {
      const r = await api.post<{ inserted: number; skipped: number; ordersCreated?: number }>(
        endpoints.adminGenesisImport,
        { rows },
        token,
      );
      await Swal.fire({
        icon: "success",
        title: "导入完成",
        text: `新增 ${r.inserted} 条，跳过 ${r.skipped} 条（已存在），创建权益订单 ${r.ordersCreated ?? 0} 条`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      setText("");
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
              <code className="text-[#b829ff] ml-1">0x地址</code> 或
              <code className="text-[#b829ff] ml-1">0x地址,等级</code>
              （未填等级时使用下方默认值）
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-white/50">未指定等级时默认：</span>
              {TIER_CHOICES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setDefaultTier(t)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    defaultTier === t
                      ? "bg-[#b829ff] text-white"
                      : "border border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                  }`}
                >
                  {TIER_LABELS[t]}
                </button>
              ))}
            </div>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`0xabc...123\n0xdef...456,glory\n0x789...000,eternal`}
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
      </div>
    </AdminGuard>
  );
}
