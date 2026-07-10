"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, ChevronLeft } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import {
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  STAKE_DEFAULT_RATES_BPS,
  type StakeAsset,
  type StakeLockMonths,
} from "@/lib/constants/business-rules";

interface RateRow {
  asset: string;
  lock_months: number;
  monthly_rate_bps: number;
}

const ASSET_LABELS: Record<string, string> = {
  USDT: "USDT",
  HS: "HS",
  LP: "LP 流动性",
};

function normalizePercentInput(value: string) {
  const cleaned = value.replace(/[^\d.]/g, "");
  const dotIndex = cleaned.indexOf(".");
  const integerPart = dotIndex === -1 ? cleaned : cleaned.slice(0, dotIndex);
  const decimalPart = dotIndex === -1 ? "" : cleaned.slice(dotIndex + 1).replace(/\./g, "").slice(0, 2);
  const integer = integerPart.replace(/^0+(?=\d)/, "");

  if (dotIndex !== -1) return `${integer || "0"}.${decimalPart}`;
  return integer;
}

function formatPercentFromBps(bps: number) {
  return (bps / 100).toFixed(2);
}

function parsePercentDraft(value: string) {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

export default function AdminRatesPage() {
  const { jwt, signIn } = useSiweJwt();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const map: Record<string, number> = {};
      for (const a of STAKE_ASSETS) {
        for (const m of STAKE_LOCK_MONTHS) {
          map[`${a}:${m}`] = STAKE_DEFAULT_RATES_BPS[a][m];
        }
      }
      try {
        const r = await api.get<{ rates: RateRow[] }>(endpoints.stakeRates);
        for (const row of r.rates ?? []) {
          map[`${row.asset}:${row.lock_months}`] = row.monthly_rate_bps;
        }
      } catch {
        /* 接口失败时展示默认值 */
      }
      setDraft(Object.fromEntries(Object.entries(map).map(([k, bps]) => [k, formatPercentFromBps(bps)])));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const update = (a: StakeAsset, m: StakeLockMonths, v: string) => {
    setDraft((prev) => ({ ...prev, [`${a}:${m}`]: normalizePercentInput(v) }));
  };

  const canonicalize = (a: StakeAsset, m: StakeLockMonths) => {
    const bps = parsePercentDraft(draft[`${a}:${m}`] ?? "");
    if (bps !== null) {
      setDraft((prev) => ({ ...prev, [`${a}:${m}`]: formatPercentFromBps(bps) }));
    }
  };

  const save = async () => {
    const rates: { asset: StakeAsset; lock_months: StakeLockMonths; monthly_rate_bps: number }[] = [];
    for (const a of STAKE_ASSETS) {
      for (const m of STAKE_LOCK_MONTHS) {
        const bps = parsePercentDraft(draft[`${a}:${m}`] ?? "");
        if (bps === null || bps > 100_000) {
          await Swal.fire({
            icon: "warning",
            title: "参数无效",
            text: `请检查 ${ASSET_LABELS[a] ?? a} ${m} 个月的利率`,
            background: "#141419",
            color: "#fff",
            confirmButtonColor: "#b829ff",
          });
          return;
        }
        rates.push({ asset: a, lock_months: m, monthly_rate_bps: bps });
      }
    }

    const token = jwt ?? (await signIn());
    if (!token) return;
    setSaving(true);
    try {
      await api.post(endpoints.adminRates, { rates }, token);
      setDraft(Object.fromEntries(rates.map((r) => [`${r.asset}:${r.lock_months}`, formatPercentFromBps(r.monthly_rate_bps)])));
      await Swal.fire({
        icon: "success",
        title: "保存成功",
        text: "新利率对新订单立即生效，已有订单不受影响。",
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({
        icon: "error",
        title: "保存失败",
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black">收益率管理</h1>
        <p className="mt-1 text-sm text-white/50">
          设置各资产不同锁仓期的月收益率。保存后仅对新订单生效。
        </p>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>月收益率（%）</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="py-8 text-center text-white/40">
                <Loader2 className="mx-auto h-5 w-5 animate-spin" />
              </div>
            ) : (
              <div className="space-y-8">
                {STAKE_ASSETS.map((a) => (
                  <div key={a}>
                    <div className="mb-3 text-sm font-bold text-white/80">{ASSET_LABELS[a] ?? a}</div>
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                      {STAKE_LOCK_MONTHS.map((m) => (
                        <div key={m} className="rounded-lg border border-white/10 bg-black/30 p-3">
                          <label className="text-xs text-white/50">{m} 个月</label>
                          <div className="mt-1 flex items-center gap-2">
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={draft[`${a}:${m}`] ?? ""}
                              onChange={(e) => update(a, m, e.target.value)}
                              onBlur={() => canonicalize(a, m)}
                            />
                            <span className="text-sm text-white/40">%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="flex justify-end gap-3 pt-4 border-t border-white/5">
                  <Button variant="outline" onClick={() => void load()}>
                    重置
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}
