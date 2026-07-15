"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { Loader2, ArrowDownUp, ChevronLeft, RefreshCw } from "lucide-react";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { shortenAddress, formatNumber } from "@/lib/utils";

interface SaleRow {
  id: string;
  user: string;
  stock_in: string;
  hs_out: string;
  stock_price_usdt: string;
  hs_price_usdt: string;
  sold_at: number;
  claim_tx_hash: string | null;
  claimed_at: number | null;
}

const EXPLORER_TX = "https://bscscan.com/tx/";

function weiToNumber(wei: string): number {
  if (!/^\d+$/.test(wei)) return 0;
  return Number(BigInt(wei) / 10n ** 12n) / 1e6;
}

export default function AdminStockSalesPage() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<{ sales: SaleRow[] }>(endpoints.adminStockSales, token);
      setRows(r.sales ?? []);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <ArrowDownUp className="h-6 w-6 text-[#00c6ff]" /> 股票卖出记录
        </h1>
        <p className="mt-1 text-sm text-white/50">
          FXHO 卖出与 HS 到账状态。用户 60 秒内未在钱包完成领取的，系统自动补发到账。
        </p>

        <Card className="mt-8">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>最近 200 笔</CardTitle>
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              刷新
            </Button>
          </CardHeader>
          <CardContent>
            {loading && rows.length === 0 ? (
              <div className="py-8 text-center text-white/40">
                <Loader2 className="mx-auto h-5 w-5 animate-spin" />
              </div>
            ) : rows.length === 0 ? (
              <div className="py-8 text-center text-sm text-white/40">暂无卖出记录</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-white/45">
                      <th className="py-2 pr-4">时间</th>
                      <th className="py-2 pr-4">用户</th>
                      <th className="py-2 pr-4 text-right">卖出 FXHO</th>
                      <th className="py-2 pr-4 text-right">到账 HS</th>
                      <th className="py-2 pr-4 text-right">折合 U</th>
                      <th className="py-2 pr-4">状态</th>
                      <th className="py-2">交易</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const stockIn = weiToNumber(r.stock_in);
                      const usdt = stockIn * Number(r.stock_price_usdt || 0);
                      return (
                        <tr key={r.id} className="border-b border-white/5">
                          <td className="py-2.5 pr-4 whitespace-nowrap text-white/70">
                            {new Date(r.sold_at * 1000).toLocaleString("zh-CN", { hour12: false })}
                          </td>
                          <td className="py-2.5 pr-4 font-mono text-white/70">{shortenAddress(r.user)}</td>
                          <td className="py-2.5 pr-4 text-right">{formatNumber(stockIn, 4)}</td>
                          <td className="py-2.5 pr-4 text-right">{formatNumber(weiToNumber(r.hs_out), 2)}</td>
                          <td className="py-2.5 pr-4 text-right text-white/60">{formatNumber(usdt, 2)}</td>
                          <td className="py-2.5 pr-4 whitespace-nowrap">
                            {r.claimed_at ? (
                              <span className="text-emerald-400">已到账</span>
                            ) : (
                              <span className="text-amber-400">待到账（自动补发中）</span>
                            )}
                          </td>
                          <td className="py-2.5">
                            {r.claim_tx_hash ? (
                              <a
                                href={`${EXPLORER_TX}${r.claim_tx_hash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-xs text-[#00c6ff] hover:underline"
                              >
                                {r.claim_tx_hash.slice(0, 10)}…
                              </a>
                            ) : (
                              <span className="text-xs text-white/30">—</span>
                            )}
                          </td>
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
