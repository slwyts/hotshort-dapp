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

interface AiCfgDraft {
  volumeMin: string;
  volumeMax: string;
  ratioPercent: string;
  directReferralPercent: Record<AiTierKey, string>;
}

function defaultDirectReferralBps(): Record<AiTierKey, number> {
  return { ...AI_REFERRAL_DIRECT_BPS };
}

function normalizeIntegerInput(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

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

function parseIntegerDraft(value: string) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePercentDraft(value: string) {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

function configToDraft(cfg: AiCfg): AiCfgDraft {
  const directReferralPercent = AI_TIERS.reduce((acc, tier) => {
    acc[tier.key] = formatPercentFromBps(cfg.directReferralBps[tier.key] ?? AI_REFERRAL_DIRECT_BPS[tier.key]);
    return acc;
  }, {} as Record<AiTierKey, string>);

  return {
    volumeMin: String(cfg.volumeMin),
    volumeMax: String(cfg.volumeMax),
    ratioPercent: formatPercentFromBps(cfg.ratioBps),
    directReferralPercent,
  };
}

function draftToConfig(draft: AiCfgDraft) {
  const volumeMin = parseIntegerDraft(draft.volumeMin);
  const volumeMax = parseIntegerDraft(draft.volumeMax);
  const ratioBps = parsePercentDraft(draft.ratioPercent);
  if (volumeMin === null || volumeMax === null || ratioBps === null) return null;

  const directReferralBps = AI_TIERS.reduce((acc, tier) => {
    acc[tier.key] = tier.key === "pioneer" ? 0 : parsePercentDraft(draft.directReferralPercent[tier.key] ?? "");
    return acc;
  }, {} as Record<AiTierKey, number | null>);
  if (AI_TIERS.some((tier) => directReferralBps[tier.key] === null)) return null;

  return {
    volumeMin,
    volumeMax,
    ratioBps,
    directReferralBps: directReferralBps as Record<AiTierKey, number>,
  };
}

export default function AdminAiConfigPage() {
  const { jwt, signIn } = useSiweJwt();
  const initialCfg: AiCfg = {
    volumeMin: 100_000,
    volumeMax: 200_000,
    ratioBps: 100,
    directReferralBps: defaultDirectReferralBps(),
  };
  const [draft, setDraft] = useState<AiCfgDraft>(() => configToDraft(initialCfg));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.get<AiCfg>(endpoints.adminAiConfig);
      const nextCfg = { ...r, directReferralBps: { ...defaultDirectReferralBps(), ...(r.directReferralBps ?? {}) } };
      setDraft(configToDraft(nextCfg));
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
    const nextCfg = draftToConfig(draft);
    if (!nextCfg) {
      await Swal.fire({ icon: "warning", title: "参数无效", text: "请检查区间和比例设置", background: "#141419", color: "#fff" });
      return;
    }
    const badDirectRate = AI_TIERS.some((tier) => {
      const bps = nextCfg.directReferralBps[tier.key];
      return tier.key !== "pioneer" && (!Number.isInteger(bps) || bps < 0 || bps > 10_000);
    });
    if (nextCfg.volumeMin <= 0 || nextCfg.volumeMax < nextCfg.volumeMin || nextCfg.ratioBps < 0 || badDirectRate) {
      await Swal.fire({ icon: "warning", title: "参数无效", text: "请检查区间和比例设置", background: "#141419", color: "#fff" });
      return;
    }
    setSaving(true);
    try {
      await api.post(endpoints.adminAiConfig, nextCfg, token);
      setDraft(configToDraft(nextCfg));
      await Swal.fire({ icon: "success", title: "保存成功", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "保存失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSaving(false);
    }
  };

  const draftVolumeMin = parseIntegerDraft(draft.volumeMin) ?? 0;
  const draftVolumeMax = parseIntegerDraft(draft.volumeMax) ?? 0;
  const draftRatioBps = parsePercentDraft(draft.ratioPercent) ?? 0;
  const dailyExample = ((draftVolumeMin + draftVolumeMax) / 2) * (draftRatioBps / 10_000);

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
                        type="text"
                        inputMode="numeric"
                        value={draft.volumeMin}
                        onChange={(e) => setDraft({ ...draft, volumeMin: normalizeIntegerInput(e.target.value) })}
                      />
                      <span className="text-sm text-white/40">USDT</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-white/70">交易额上限</label>
                    <div className="mt-1 flex items-center gap-2">
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={draft.volumeMax}
                        onChange={(e) => setDraft({ ...draft, volumeMax: normalizeIntegerInput(e.target.value) })}
                      />
                      <span className="text-sm text-white/40">USDT</span>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-white/70">分红比例</label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={draft.ratioPercent}
                      onChange={(e) => setDraft({ ...draft, ratioPercent: normalizePercentInput(e.target.value) })}
                      onBlur={() => {
                        const ratioBps = parsePercentDraft(draft.ratioPercent);
                        if (ratioBps !== null) setDraft({ ...draft, ratioPercent: formatPercentFromBps(ratioBps) });
                      }}
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
                  <div className="mt-1 text-xs text-white/45">按邀请人自身最高套餐计算，开拓者固定无返佣。</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {AI_TIERS.map((tier) => {
                      const disabled = tier.key === "pioneer";
                      return (
                        <div key={tier.key}>
                          <label className="text-xs font-medium text-white/60">{tier.label} {tier.usdt}U</label>
                          <div className="mt-1 flex items-center gap-2">
                            <Input
                              type="text"
                              inputMode="decimal"
                              disabled={disabled}
                              value={draft.directReferralPercent[tier.key] ?? "0.00"}
                              onChange={(e) => setDraft({
                                ...draft,
                                directReferralPercent: {
                                  ...draft.directReferralPercent,
                                  [tier.key]: normalizePercentInput(e.target.value),
                                  pioneer: "0.00",
                                },
                              })}
                              onBlur={() => {
                                const bps = parsePercentDraft(draft.directReferralPercent[tier.key] ?? "");
                                if (bps !== null) {
                                  setDraft({
                                    ...draft,
                                    directReferralPercent: {
                                      ...draft.directReferralPercent,
                                      [tier.key]: formatPercentFromBps(bps),
                                      pioneer: "0.00",
                                    },
                                  });
                                }
                              }}
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
