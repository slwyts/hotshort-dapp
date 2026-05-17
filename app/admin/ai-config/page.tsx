"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, BarChart3 } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { bpsToPercent } from "@/lib/constants/business-rules";

interface AiCfg {
  volumeMin: number;
  volumeMax: number;
  ratioBps: number;
}

export default function AdminAiConfigPage() {
  const { jwt, signIn } = useSiweJwt();
  const [cfg, setCfg] = useState<AiCfg>({ volumeMin: 100_000, volumeMax: 200_000, ratioBps: 100 });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.get<AiCfg>(endpoints.adminAiConfig);
      setCfg(r);
    } catch {
      /* 默认值 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    if (cfg.volumeMin <= 0 || cfg.volumeMax < cfg.volumeMin || cfg.ratioBps < 0) {
      await Swal.fire({ icon: "warning", title: "参数无效", background: "#141419", color: "#fff" });
      return;
    }
    setSaving(true);
    try {
      await api.post(endpoints.adminAiConfig, cfg, token);
      await Swal.fire({ icon: "success", title: "已保存", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  const dailyExample = ((cfg.volumeMin + cfg.volumeMax) / 2) * (cfg.ratioBps / 10_000);

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-black flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-[#00c6ff]" /> AI 量化配置
        </h1>
        <p className="mt-1 text-sm text-white/50">
          README §2.2 每日交易额区间 + 分红比例。每日 cron 在区间内随机一个值，乘以比例进入分红池。
        </p>

        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>每日股票分红参数</CardTitle>
            <CardDescription>示例：10w-20w 区间 × 1% → 平均日分红池 ≈ 1500 USDT</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs uppercase tracking-widest text-white/50">区间下限（USDT）</label>
                    <Input
                      type="number"
                      min={0}
                      value={cfg.volumeMin}
                      onChange={(e) => setCfg({ ...cfg, volumeMin: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-widest text-white/50">区间上限（USDT）</label>
                    <Input
                      type="number"
                      min={0}
                      value={cfg.volumeMax}
                      onChange={(e) => setCfg({ ...cfg, volumeMax: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-widest text-white/50">
                    分红比例（bps；100 = 1%）
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={10_000}
                    value={cfg.ratioBps}
                    onChange={(e) => setCfg({ ...cfg, ratioBps: Number(e.target.value) })}
                  />
                  <div className="mt-1 text-xs text-[#00c6ff]">≈ {bpsToPercent(cfg.ratioBps)}</div>
                </div>
                <div className="rounded-md border border-[#00c6ff]/30 bg-[#00c6ff]/5 p-3 text-xs text-[#00c6ff]">
                  📊 每日分红池 USDT 估算：{Math.round(dailyExample).toLocaleString("en-US")}
                </div>
                <Button onClick={save} disabled={saving} className="ml-auto">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  保存
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}
