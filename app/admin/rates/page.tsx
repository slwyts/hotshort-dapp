"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import {
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  STAKE_DEFAULT_RATES_BPS,
  bpsToPercent,
  type StakeAsset,
  type StakeLockMonths,
} from "@/lib/constants/business-rules";

interface RateRow {
  asset: string;
  lock_months: number;
  monthly_rate_bps: number;
}

export default function AdminRatesPage() {
  const { jwt, signIn } = useSiweJwt();
  const [rates, setRates] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ rates: RateRow[] }>(endpoints.stakeOrders.replace("/orders", "/rates"));
      const map: Record<string, number> = {};
      // 先填默认
      for (const a of STAKE_ASSETS) {
        for (const m of STAKE_LOCK_MONTHS) {
          map[`${a}:${m}`] = STAKE_DEFAULT_RATES_BPS[a][m];
        }
      }
      // 再覆盖 DB
      for (const row of r.rates ?? []) {
        map[`${row.asset}:${row.lock_months}`] = row.monthly_rate_bps;
      }
      setRates(map);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const update = (a: StakeAsset, m: StakeLockMonths, v: string) => {
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) return;
    setRates((prev) => ({ ...prev, [`${a}:${m}`]: Math.floor(num) }));
  };

  const save = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSaving(true);
    try {
      const payload = {
        rates: STAKE_ASSETS.flatMap((a) =>
          STAKE_LOCK_MONTHS.map((m) => ({
            asset: a,
            lock_months: m,
            monthly_rate_bps: rates[`${a}:${m}`] ?? STAKE_DEFAULT_RATES_BPS[a][m],
          })),
        ),
      };
      await api.post(endpoints.adminRates, payload, token);
      await Swal.fire({
        icon: "success",
        title: "已保存",
        text: "新订单将以新利率结算。已存订单不受影响。",
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
        <h1 className="text-2xl font-black">利率配置</h1>
        <p className="mt-1 text-sm text-white/50">
          单位为 bps（1% = 100 bps）。保存后只影响新订单，已存订单使用下单时的快照利率。
        </p>

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>月化收益率</CardTitle>
            <CardDescription>README §1.3 基准：USDT/HS 0.5/2/4/8%；LP 1/3/10/24%</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="py-8 text-center text-white/40">
                <Loader2 className="mx-auto h-5 w-5 animate-spin" />
              </div>
            ) : (
              <div className="space-y-6">
                {STAKE_ASSETS.map((a) => (
                  <div key={a}>
                    <div className="mb-2 text-sm font-bold text-white/70">{a}</div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {STAKE_LOCK_MONTHS.map((m) => (
                        <div key={m}>
                          <label className="text-xs text-white/40">{m} 月（bps）</label>
                          <Input
                            type="number"
                            min={0}
                            value={rates[`${a}:${m}`] ?? ""}
                            onChange={(e) => update(a, m, e.target.value)}
                          />
                          <div className="mt-1 text-xs text-[#00c6ff]">
                            ≈ {bpsToPercent(rates[`${a}:${m}`] ?? 0)} / 月
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="flex justify-end gap-2 pt-4">
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
