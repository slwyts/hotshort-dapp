"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, BarChart3, ChevronLeft } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { AI_REFERRAL_DIRECT_BPS, AI_TIERS, type AiTierKey } from "@/lib/constants/business-rules";

interface AiCfg {
  volumeMin: number;
  volumeMax: number;
  ratioBps: number;
  directReferralBps: Record<AiTierKey, number>;
}

function defaultDirectReferralBps(): Record<AiTierKey, number> {
  return { ...AI_REFERRAL_DIRECT_BPS };
}

export default function AdminAiConfigPage() {
  const { jwt, signIn } = useSiweJwt();
  const [cfg, setCfg] = useState<AiCfg>({
    volumeMin: 100_000,
    volumeMax: 200_000,
    ratioBps: 100,
    directReferralBps: defaultDirectReferralBps(),
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.get<AiCfg>(endpoints.adminAiConfig);
      setCfg({ ...r, directReferralBps: { ...defaultDirectReferralBps(), ...(r.directReferralBps ?? {}) } });
    } catch {
      /* 使用默认值 */
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
    const badDirectRate = AI_TIERS.some((tier) => {
      const bps = cfg.directReferralBps[tier.key];
      return tier.key !== "pioneer" && (!Number.isInteger(bps) || bps < 0 || bps > 10_000);
    });
    if (cfg.volumeMin <= 0 || cfg.volumeMax < cfg.volumeMin || cfg.ratioBps < 0 || badDirectRate) {
      await Swal.fire({ icon: "warning", title: "参数无效", text: "请检查区间和比例设置", background: "#141419", color: "#fff" });
      return;
    }
    setSaving(true);
    try {
      await api.post(endpoints.adminAiConfig, cfg, token);
      await Swal.fire({ icon: "success", title: "保存成功", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "保存失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  const ratioPercent = cfg.ratioBps / 100;
  const dailyExample = ((cfg.volumeMin + cfg.volumeMax) / 2) * (cfg.ratioBps / 10_000);

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-[#00c6ff]" /> AI 量化配置
        </h1>
        <p className="mt-1 text-sm text-white/50">
          设置每日模拟交易金额范围和分红比例，系统每天自动在区间内随机生成交易额
        </p>

        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>每日分红池参数</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {loading ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium text-white/70">交易额下限</label>
                    <div className="mt-1 flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        value={cfg.volumeMin}
                        onChange={(e) => setCfg({ ...cfg, volumeMin: Number(e.target.value) })}
                      />
                      <span className="text-sm text-white/40">USDT</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-white/70">交易额上限</label>
                    <div className="mt-1 flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        value={cfg.volumeMax}
                        onChange={(e) => setCfg({ ...cfg, volumeMax: Number(e.target.value) })}
                      />
                      <span className="text-sm text-white/40">USDT</span>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-white/70">分红比例</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      value={ratioPercent.toFixed(2)}
                      onChange={(e) => setCfg({ ...cfg, ratioBps: Math.round(Number(e.target.value) * 100) })}
                    />
                    <span className="text-sm text-white/40">%</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[#00c6ff]/20 bg-[#00c6ff]/5 p-4">
                  <div className="text-xs text-white/50">预估每日分红池</div>
                  <div className="mt-1 text-lg font-bold text-[#00c6ff]">
                    ≈ {Math.round(dailyExample).toLocaleString("en-US")} USDT
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                  <div className="text-sm font-semibold text-white/75">套餐直推一次性返佣</div>
                  <div className="mt-1 text-xs text-white/45">按下级购买套餐计算，开拓者固定无返佣。</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {AI_TIERS.map((tier) => {
                      const disabled = tier.key === "pioneer";
                      const percent = (cfg.directReferralBps[tier.key] ?? 0) / 100;
                      return (
                        <div key={tier.key}>
                          <label className="text-xs font-medium text-white/60">{tier.label} {tier.usdt}U</label>
                          <div className="mt-1 flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              max={disabled ? 0 : 100}
                              step="0.01"
                              disabled={disabled}
                              value={percent.toFixed(2)}
                              onChange={(e) => setCfg({
                                ...cfg,
                                directReferralBps: {
                                  ...cfg.directReferralBps,
                                  [tier.key]: Math.round(Number(e.target.value) * 100),
                                  pioneer: 0,
                                },
                              })}
                            />
                            <span className="text-sm text-white/40">%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
