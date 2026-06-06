"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import { StakeForm } from "@/components/stake/stake-form";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { useLocale } from "@/components/locale-provider";
import { api, endpoints } from "@/lib/api";
import Swal from "sweetalert2";

export default function StakePage() {
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
  };

  return (
    <PageShell>
      <h1 className="mb-3 text-xl font-black">{t("stake.title")}</h1>
      <div className="space-y-4">
        <StakeForm onDeposited={onDeposited} />
        <Card>
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div>
              <div className="text-sm font-bold">订单详情</div>
              <div className="mt-0.5 text-xs text-white/45">质押进度、到期收益和领取都在订单中心查看</div>
            </div>
            <Link href="/me?tab=orders&type=stake">
              <Button size="sm" variant="outline">查看订单</Button>
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div>
              <div className="text-sm font-bold">质押燃烧分红（5%）</div>
              <div className="mt-0.5 text-xs text-white/45">质押满 6 个月可享全网 5% 燃烧权重分红，在燃烧订单中领取</div>
            </div>
            <Link href="/me?tab=orders&type=burn">
              <Button size="sm" variant="outline">领取分红</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
