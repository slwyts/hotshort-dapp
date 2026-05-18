"use client";

import Image from "next/image";
import { useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, keccak256, parseUnits, toHex } from "viem";
import { Loader2 } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/page-shell";
import { AiSubnav } from "@/components/ai-subnav";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { useReferralGate } from "@/lib/hooks/use-referral-gate";
import { api, endpoints } from "@/lib/api";
import { ERC20_ABI, VAULT_ABI } from "@/lib/contracts/abis";
import { DEPOSIT_PURPOSE } from "@/lib/contracts/addresses";
import { useContracts } from "@/lib/runtime-config";
import { AI_TIERS, BPS_DENOMINATOR, type AiTierKey } from "@/lib/constants/business-rules";
import { formatNumber } from "@/lib/utils";

const TIER_VISUAL: Record<AiTierKey, { mascot: string; theme: string; sub: string; dividend: string }> = {
  genesis: { mascot: "/mascots/overnight.png", theme: "#f59e0b", sub: "GENESIS", dividend: "56%" },
  glory: { mascot: "/mascots/fire.png", theme: "#e11d48", sub: "GLORY", dividend: "25%" },
  eternal: { mascot: "/mascots/rich.png", theme: "#eab308", sub: "ETERNAL", dividend: "12%" },
  shine: { mascot: "/mascots/nice.png", theme: "#8b5cf6", sub: "SHINE", dividend: "6%" },
  pioneer: { mascot: "/mascots/lucky.png", theme: "#14b8a6", sub: "PIONEER", dividend: "1%" },
};

export default function AiPage() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { writeContractAsync } = useWriteContract();
  const { t } = useLocale();
  const { vault, usdtToken } = useContracts();
  const { ensureBound } = useReferralGate();
  const [pending, setPending] = useState<AiTierKey | null>(null);

  const { data: usdtBal } = useReadContract({
    abi: ERC20_ABI,
    address: usdtToken,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const usdtNum = usdtBal ? Number(formatUnits(usdtBal as bigint, 18)) : 0;

  const buy = async (tier: AiTierKey, usdt: number) => {
    if (!isConnected || !address) {
      await Swal.fire({ icon: "warning", title: t("common.connectFirst"), background: "#141419", color: "#fff" });
      return;
    }
    if (vault === "0x0000000000000000000000000000000000000000") {
      await Swal.fire({ icon: "info", title: t("ai.notReady"), text: t("ai.notReady.text"), background: "#141419", color: "#fff" });
      return;
    }
    if (!(await ensureBound())) return;
    if (usdtNum < usdt) {
      const tierMeta = AI_TIERS.find((x) => x.key === tier)!;
      await Swal.fire({
        icon: "warning",
        title: t("ai.usdtNotEnough"),
        text: t("ai.usdtNotEnough.body", {
          tier: t(`ai.tier.${tierMeta.key}`),
          need: usdt,
          have: formatNumber(usdtNum, 2),
        }),
        background: "#141419",
        color: "#fff",
      });
      return;
    }

    const token = jwt ?? (await signIn());
    if (!token) return;

    setPending(tier);
    try {
      const amountWei = parseUnits(String(usdt), 18);

      Swal.fire({
        title: t("ai.txApprove"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      await writeContractAsync({
        address: usdtToken,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vault, amountWei],
      });

      Swal.fire({
        title: t("ai.txBuy"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      const ref = keccak256(toHex(`ai|${address}|${tier}|${Date.now()}`));
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [usdtToken, amountWei, DEPOSIT_PURPOSE.AI_PACKAGE, ref],
      });

      await api.post(
        endpoints.aiBuy,
        {
          sourceTxHash: txHash,
          tier,
        },
        token,
      );

      const tierMeta = AI_TIERS.find((x) => x.key === tier)!;
      const stockGrant = (usdt * tierMeta.stockGrantBps) / BPS_DENOMINATOR;
      Swal.fire({
        icon: "success",
        title: t("ai.success.title"),
        html: `
          <div style="text-align:left; line-height:1.8;">
            <p>${t("ai.success.bought", { tier: t(`ai.tier.${tierMeta.key}`) })}</p>
            ${stockGrant > 0
              ? `<p>${t("ai.success.gift", { amount: formatNumber(stockGrant, 2) })}</p>`
              : `<p class="text-white/50 text-xs">${t("ai.success.noGift")}</p>`}
            <a href="https://bscscan.com/tx/${txHash}" target="_blank" rel="noopener" class="text-[#00c6ff] text-xs">${t("ai.success.viewTx")}</a>
          </div>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      Swal.close();
      await Swal.fire({
        icon: "error",
        title: t("ai.failed.title"),
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <PageShell>
      <h1 className="mb-1 text-xl font-black">{t("ai.title")}</h1>
      <p className="mb-3 text-xs text-white/50">{t("ai.subtitle.plans")}</p>
      <AiSubnav />

      <div className="space-y-3">
        {AI_TIERS.map((tier) => {
          const v = TIER_VISUAL[tier.key as AiTierKey];
          const isPending = pending === tier.key;
          const eligible = isConnected && usdtNum >= tier.usdt;
          return (
            <Card
              key={tier.key}
              className="relative overflow-hidden border-l-[3px]"
              style={{ borderLeftColor: v.theme }}
            >
              <div
                className="pointer-events-none absolute -right-6 -top-6 h-32 w-32 rounded-full opacity-20 blur-2xl"
                style={{ background: v.theme }}
              />
              <CardContent className="relative flex items-center gap-3 py-4">
                <Image
                  src={v.mascot}
                  alt={tier.label}
                  width={64}
                  height={64}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-black">{t(`ai.tier.${tier.key}`)}</span>
                    <span className="text-[10px] uppercase tracking-wider opacity-60" style={{ color: v.theme }}>
                      {v.sub}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1">
                    <span
                      className="text-2xl font-black tabular-nums"
                      style={{ fontFamily: "Orbitron, sans-serif" }}
                    >
                      {tier.usdt}
                    </span>
                    <span className="text-xs text-white/50">USDT</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-white/50">
                    <span>{t("ai.giftStock", { amount: (tier.usdt * tier.stockGrantBps / BPS_DENOMINATOR).toFixed(0) })}</span>
                    <span>·</span>
                    <span>{t("ai.dailyDividend", { ratio: v.dividend })}</span>
                  </div>
                </div>
                <Button
                  onClick={() => buy(tier.key as AiTierKey, tier.usdt)}
                  disabled={isPending || !eligible}
                  size="sm"
                  className="shrink-0"
                  style={
                    eligible
                      ? { background: `linear-gradient(135deg, ${v.theme}, #2a0a3a)` }
                      : undefined
                  }
                  variant={eligible ? "default" : "outline"}
                >
                  {isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : !isConnected ? (
                    t("ai.connect")
                  ) : !eligible ? (
                    t("ai.insufficient")
                  ) : (
                    t("ai.buy")
                  )}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="mt-4 text-center text-[11px] text-white/40">
        {t("ai.referralTip")}
      </p>
    </PageShell>
  );
}
