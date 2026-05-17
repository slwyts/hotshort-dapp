"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import { StakeForm } from "@/components/stake/stake-form";
import { OrderList } from "@/components/stake/order-list";
import { PageShell } from "@/components/page-shell";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { useLocale } from "@/components/locale-provider";
import { api, endpoints } from "@/lib/api";
import { getStoredReferrer } from "@/components/referral-handler";
import Swal from "sweetalert2";

export default function StakePage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { signIn, jwt } = useSiweJwt();
  const { t } = useLocale();

  const onDeposited = async (info: {
    asset: "USDT" | "HS" | "LP";
    amountWei: bigint;
    lockMonths: 1 | 3 | 6 | 12;
    txHash: `0x${string}`;
  }) => {
    const token = jwt ?? (await signIn());
    if (!token) {
      Swal.fire({
        icon: "warning",
        title: t("error.title"),
        text: t("error.signRequired"),
        background: "#141419",
        color: "#fff",
      });
      return;
    }
    try {
      await api.post(
        endpoints.stakeOrders,
        {
          sourceTxHash: info.txHash,
          asset: info.asset,
          amountWei: info.amountWei.toString(),
          lockMonths: info.lockMonths,
          referrer: getStoredReferrer() ?? undefined,
        },
        token,
      );
      Swal.fire({
        icon: "success",
        title: t("stake.success.title"),
        html: `${t("stake.success.body", {
          amount: Number(formatUnits(info.amountWei, 18)).toLocaleString("en-US"),
          asset: info.asset,
        })}<br/>
               <span class="text-xs text-white/50">${t("stake.success.note")}</span>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      Swal.fire({
        icon: "warning",
        title: t("stake.recordFailed"),
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    }
    setRefreshKey((k) => k + 1);
  };

  return (
    <PageShell>
      <h1 className="mb-3 text-xl font-black">{t("stake.title")}</h1>
      <div className="space-y-4">
        <StakeForm onDeposited={onDeposited} />
        <OrderList refreshKey={refreshKey} />
      </div>
    </PageShell>
  );
}
