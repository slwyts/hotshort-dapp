"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { Loader2, Sparkles, Award } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/page-shell";
import { AiSubnav } from "@/components/ai-subnav";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { VAULT_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { formatNumber } from "@/lib/utils";
import {
  AI_AIRDROP_MIN_DAILY_STOCK,
  AI_AIRDROP_BASE_APR_BPS,
  AI_AIRDROP_BURN_WEIGHT_BPS,
  AI_AIRDROP_MIN_HS_USDT,
  bpsToPercent,
} from "@/lib/constants/business-rules";

interface DividendResponse {
  today: string;
  holdings: { totalStock: string; lockedStock: string };
  dividend: { date: string; stock_share: string; claimed: number };
}

export default function DividendPage() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { writeContractAsync } = useWriteContract();
  const { t } = useLocale();
  const { vault } = useContracts();
  const [data, setData] = useState<DividendResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimingAirdrop, setClaimingAirdrop] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<DividendResponse>(endpoints.aiDividendToday, token);
      setData(r);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaiming(true);
    try {
      const r = await api.post<{ token: string | null; amount: string; note?: string }>(
        endpoints.aiDividendClaim,
        {},
        token,
      );
      if (!r.token || r.amount === "0") {
        await Swal.fire({
          icon: "info",
          title: t("ai.div.noClaim.title"),
          text: t("ai.div.noClaim.body"),
          background: "#141419",
          color: "#fff",
          confirmButtonColor: "#b829ff",
        });
      } else {
        const stockNum = Number(formatUnits(BigInt(r.amount), 18));
        await Swal.fire({
          icon: "success",
          title: t("ai.div.claimSuccess.title"),
          html: t("ai.div.claimSuccess.body", { amount: formatNumber(stockNum, 2) }),
          background: "#141419",
          color: "#fff",
          confirmButtonColor: "#b829ff",
        });
        await refresh();
      }
    } catch (e) {
      await Swal.fire({
        icon: "error",
        title: t("error.title"),
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setClaiming(false);
    }
  };

  const claimAirdrop = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaimingAirdrop(true);
    try {
      const sig = await api.post<{
        token?: string | null;
        recipients?: string[];
        amounts?: string[];
        amount: string;
        nonce?: string;
        deadline?: number;
        reason?: number;
        signature?: string;
      }>(endpoints.aiAirdropClaim, {}, token);
      if (!sig.signature || !sig.token || sig.amount === "0") {
        await Swal.fire({ icon: "info", title: t("ai.div.noClaim.title"), text: t("ai.div.noClaim.body"), background: "#141419", color: "#fff" });
        return;
      }
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "claim",
        args: [
          sig.token as `0x${string}`,
          sig.recipients as `0x${string}`[],
          sig.amounts!.map((amount) => BigInt(amount)),
          BigInt(sig.nonce!),
          BigInt(sig.deadline!),
          sig.reason!,
          sig.signature as `0x${string}`,
        ],
      });
      await Swal.fire({
        icon: "success",
        title: t("ai.div.airdropClaimSuccess.title"),
        html: t("ai.div.airdropClaimSuccess.body", { amount: formatNumber(Number(formatUnits(BigInt(sig.amount), 18)), 2), tx: txHash.slice(0, 10) }),
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaimingAirdrop(false);
    }
  };

  if (!isConnected) {
    return (
      <PageShell>
        <h1 className="mb-3 text-xl font-black">{t("ai.title")}</h1>
        <AiSubnav />
        <Card>
          <CardContent className="py-16 text-center text-white/50">{t("ai.div.connect")}</CardContent>
        </Card>
      </PageShell>
    );
  }

  if (loading || !data) {
    return (
      <PageShell>
        <h1 className="mb-3 text-xl font-black">{t("ai.title")}</h1>
        <AiSubnav />
        <div className="py-12 text-center text-white/40">
          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
        </div>
      </PageShell>
    );
  }

  const totalStock = Number(formatUnits(BigInt(data.holdings.totalStock), 18));
  const lockedStock = Number(formatUnits(BigInt(data.holdings.lockedStock), 18));
  const todayShare = Number(formatUnits(BigInt(data.dividend.stock_share), 18));
  const unlocked = AI_AIRDROP_MIN_DAILY_STOCK <= totalStock;

  return (
    <PageShell>
      <h1 className="mb-1 text-xl font-black">{t("ai.title")}</h1>
      <p className="mb-3 text-xs text-white/50">{t("ai.subtitle.dividend")}</p>
      <AiSubnav />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[#00c6ff]" /> {t("ai.div.todayTitle")}
            <span className="text-xs font-normal text-white/40">{data.today}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Stat label={t("ai.div.holding")} value={formatNumber(totalStock, 2)} unit={t("ai.div.unit")} />
            <Stat label={t("ai.div.locked")} value={formatNumber(lockedStock, 2)} unit={t("ai.div.unit")} subtle />
            <Stat
              label={t("ai.div.todayShare")}
              value={formatNumber(todayShare, 2)}
              unit={t("ai.div.unit")}
              accent
              suffix={data.dividend.claimed ? t("ai.div.claimed") : ""}
            />
            <Stat
              label={t("ai.div.pending")}
              value={data.dividend.claimed ? "0" : formatNumber(todayShare, 2)}
              unit={t("ai.div.unit")}
            />
          </div>

          <Button
            onClick={claim}
            disabled={claiming || (todayShare === 0 && data.dividend.claimed === 1)}
            size="lg"
            className="w-full"
          >
            {claiming ? <Loader2 className="h-4 w-4 animate-spin" /> : t("ai.div.claim")}
          </Button>
        </CardContent>
      </Card>

      <Card className="mt-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Award className="h-5 w-5 text-[#b829ff]" /> {t("ai.div.airdropTitle")}
          </CardTitle>
          <CardDescription>
            {t("ai.div.airdropDesc", { min: AI_AIRDROP_MIN_DAILY_STOCK, hs: AI_AIRDROP_MIN_HS_USDT })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            className={`rounded-xl border p-3 text-sm ${unlocked ? "border-[#00c6ff]/40 bg-[#00c6ff]/5 text-[#00c6ff]" : "border-white/10 bg-white/[0.02] text-white/40"}`}
          >
            {unlocked ? t("ai.div.airdropOk") : t("ai.div.airdropNeed", { amount: formatNumber(AI_AIRDROP_MIN_DAILY_STOCK - totalStock, 0) })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-white/5 bg-black/40 p-3">
              <div className="text-[11px] text-white/40">{t("ai.div.airdropBase")}</div>
              <div className="mt-0.5 text-xl font-bold text-white">{t("ai.div.airdropBaseValue", { pct: bpsToPercent(AI_AIRDROP_BASE_APR_BPS) })}</div>
              <div className="mt-0.5 text-[10px] text-white/30">{t("ai.div.airdropBaseHint")}</div>
            </div>
            <div className="rounded-xl border border-white/5 bg-black/40 p-3">
              <div className="text-[11px] text-white/40">{t("ai.div.airdropBoost")}</div>
              <div className="mt-0.5 text-xl font-bold text-white">{bpsToPercent(AI_AIRDROP_BURN_WEIGHT_BPS)}</div>
              <div className="mt-0.5 text-[10px] text-white/30">{t("ai.div.airdropBoostHint")}</div>
            </div>
          </div>
          <p className="text-[11px] text-white/30">
            {t("ai.div.weeklyHint")}
          </p>
          <Button onClick={claimAirdrop} disabled={claimingAirdrop || !unlocked} className="w-full">
            {claimingAirdrop ? <Loader2 className="h-4 w-4 animate-spin" /> : t("ai.div.claimAirdrop")}
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function Stat({
  label,
  value,
  unit,
  accent,
  subtle,
  suffix,
}: {
  label: string;
  value: string;
  unit: string;
  accent?: boolean;
  subtle?: boolean;
  suffix?: string;
}) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? "border-[#b829ff]/30 bg-[#b829ff]/5" : "border-white/5 bg-black/40"}`}>
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      <div
        className={`mt-0.5 text-xl font-black tabular-nums ${accent ? "text-[#b829ff]" : subtle ? "text-white/50" : "text-white"}`}
      >
        {value}
        <span className="ml-1 text-[10px] text-white/30">{unit}</span>
      </div>
      {suffix && <div className="mt-0.5 text-[9px] text-white/40">{suffix}</div>}
    </div>
  );
}
