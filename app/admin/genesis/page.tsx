"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Upload, Search, ChevronLeft, Database } from "lucide-react";
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
const TIER_LABELS: Record<string, string> = {
  genesis: "创世",
  glory: "荣耀",
  eternal: "永恒",
  shine: "鑫耀",
  pioneer: "开拓者",
};

export default function AdminGenesisPage() {
  const { jwt, signIn } = useSiweJwt();
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);

  const onFile = async (file: File) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out: ParsedRow[] = [];
    for (const line of lines) {
      const [a, t] = line.split(",").map((s) => s.trim());
      if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) continue;
      const tier = TIER_CHOICES.find((x) => x === t) ?? "genesis";
      out.push({ address: a.toLowerCase(), tier });
    }
    setRows(out);
  };

  const upload = async () => {
    if (rows.length === 0) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setImporting(true);
    try {
      const r = await api.post<{ inserted: number; skipped: number }>(
        endpoints.adminGenesisImport,
        { rows },
        token,
      );
      await Swal.fire({
        icon: "success",
        title: "导入完成",
        text: `新增 ${r.inserted} 条，跳过 ${r.skipped} 条（已存在）`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      setRows([]);
    } catch (e) {
      await Swal.fire({ icon: "error", title: "导入失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setImporting(false);
    }
  };

  const scan = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setScanning(true);
    try {
      const r = await api.post<{ inserted: number; scanned: number }>(
        "/admin/genesis-scan",
        {},
        token,
      );
      await Swal.fire({
        icon: "success",
        title: "扫描完成",
        text: `新增 ${r.inserted} 条，共扫描 ${r.scanned} 笔转账记录`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "扫描失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setScanning(false);
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
          导入和管理创世用户名单，支持 CSV 上传或链上自动扫描
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-[#00c6ff]" />
                CSV 导入
              </CardTitle>
              <p className="text-xs text-white/40">
                每行格式：<code className="text-[#b829ff]">0x地址,等级</code>（等级可选：genesis/glory/eternal/shine/pioneer）
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
                className="block w-full text-sm text-white/70 file:mr-4 file:rounded-md file:border-0 file:bg-[#b829ff]/20 file:px-3 file:py-2 file:text-[#b829ff] hover:file:bg-[#b829ff]/30"
              />
              {rows.length > 0 && (
                <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs">
                  <div className="font-bold text-white/70">已解析 {rows.length} 条记录</div>
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
                确认导入
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-5 w-5 text-[#00c6ff]" />
                链上自动扫描
              </CardTitle>
              <p className="text-xs text-white/40">
                自动扫描链上 USDT 转账记录，按金额匹配对应等级后入库
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-3 text-xs text-yellow-300">
                按 5000/2000/1000/500/100 USDT（±5%）自动匹配等级，超出范围的记录会跳过
              </div>
              <Button variant="outline" onClick={scan} disabled={scanning}>
                {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                开始扫描
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminGuard>
  );
}
