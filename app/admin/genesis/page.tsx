"use client";

import { useState } from "react";
import { Loader2, Upload, Search } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";

interface ParsedRow {
  address: string;
  tier: string;
}

const TIER_CHOICES = ["genesis", "glory", "eternal", "shine", "pioneer"] as const;

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
      await Swal.fire({
        icon: "error",
        title: "失败",
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
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
        text: `新增 ${r.inserted} 条 / 已扫 ${r.scanned} 条 USDT 转账`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({
        icon: "error",
        title: "扫描失败",
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setScanning(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-black">创世节点名单</h1>
        <p className="mt-1 text-sm text-white/50">
          来源 1：CSV 上传（推荐）。来源 2：从 genesis-hotshort 收款 EOA 链上扫描历史 USDT.transfer。
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-[#00c6ff]" />
                CSV 上传
              </CardTitle>
              <CardDescription>
                每行格式：<code className="text-[#b829ff]">0x地址,tier</code>。tier ∈ genesis/glory/eternal/shine/pioneer
              </CardDescription>
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
                <div className="rounded-lg border border-white/10 bg-black/40 p-3 text-xs">
                  <div className="font-bold text-white/70">解析到 {rows.length} 条</div>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-white/50">
                    {rows.slice(0, 50).map((r) => (
                      <li key={r.address} className="font-mono">
                        {r.address.slice(0, 10)}...{r.address.slice(-6)}
                        <span className="ml-2 text-[#00c6ff]">[{r.tier}]</span>
                      </li>
                    ))}
                    {rows.length > 50 && <li className="text-white/30">...</li>}
                  </ul>
                </div>
              )}
              <Button onClick={upload} disabled={importing || rows.length === 0}>
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                导入到 D1
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-5 w-5 text-[#00c6ff]" />
                链上扫描备选路径
              </CardTitle>
              <CardDescription>
                调用 BscScan API 拉 RECEIVER=0x6800...bC55 的 USDT.transfer，金额匹配 5 档套餐自动入库。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-300">
                需配置 BSCSCAN_API_KEY；金额按 5000/2000/1000/500/100 USDT 容差 ±5% 匹配；超出此范围跳过。
              </div>
              <Button variant="outline" onClick={scan} disabled={scanning}>
                {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                立即扫描
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminGuard>
  );
}
