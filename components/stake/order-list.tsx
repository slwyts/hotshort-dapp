"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { Loader2, Clock, CheckCircle, Lock } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { VAULT_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { useServerTime } from "@/hooks/use-server-time";
import { bpsToPercent } from "@/lib/constants/business-rules";
import { cn, formatNumber, shortenAddress } from "@/lib/utils";
import { formatUnits } from "viem";interface StakeOrder {
  id: string;
  asset: string;
  amount: string;
  lock_months: number;
  monthly_rate_bps: number;
  started_at: number;
  matures_at: number;
  claimed: number;
  claim_tx_hash: string | null;
  source_tx_hash: string;
}

export function OrderList({ refreshKey }: { refreshKey: number }) {
  const { address, isConnected } = useAccount();
  const { t } = useLocale();
  const { jwt, signIn } = useSiweJwt();
  const [orders, setOrders] = useState<StakeOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const { writeContractAsync } = useWriteContract();
  const { vault } = useContracts();
  const serverNow = useServerTime();
  const refresh = useCallback(async () => {
    if (!isConnected || !address) return;
    let token = jwt;
    if (!token) token = await signIn();
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.get<{ orders: StakeOrder[] }>(endpoints.stakeOrders, token);
      setOrders(r.orders ?? []);
    } catch {
      /* swallow; UI 显示空 */
    } finally {
      setLoading(false);
    }
  }, [address, isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const claim = async (id: string) => {
    let token = jwt;
    if (!token) token = await signIn();
    if (!token) return;
    try {
      Swal.fire({
        title: t("stake.claim.preparing"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      const sig = await api.post<{
        token: string;
        tokens?: string[];
        recipients: string[];
        amounts: string[];
        amount: string;
        nonce: string;
        deadline: number;
        reason: number;
        signature: string;
        claimableHs: string;
        fuelBurnHs: string;
      }>(endpoints.stakeClaim, { orderId: id }, token);

      Swal.fire({
        title: t("stake.claim.confirm"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "claim",
        args: [
          (sig.tokens ?? sig.amounts.map(() => sig.token)) as `0x${string}`[],
          sig.recipients as `0x${string}`[],
          sig.amounts.map((amount) => BigInt(amount)),
          BigInt(sig.nonce),
          BigInt(sig.deadline),
          sig.reason,
          sig.signature as `0x${string}`,
        ],
      });

      // 即时确认：告诉后端 tx 已上链
      api.post(endpoints.stakeConfirm, { orderId: id, txHash }, token).catch((e: unknown) => console.error("stake confirm failed", e));

      Swal.fire({
        icon: "success",
        title: t("stake.claim.successTitle"),
        html: `<p>${t("stake.claim.successBody", { amount: formatNumber(Number(formatUnits(BigInt(sig.claimableHs), 18)), 4) })}</p>
               <p class="text-xs text-white/50 mt-2">${t("stake.claim.fuelNote", { amount: formatNumber(Number(formatUnits(BigInt(sig.fuelBurnHs), 18)), 4) })}</p>
               <a href="https://bscscan.com/tx/${txHash}" target="_blank" rel="noopener" class="text-[#00c6ff] text-xs">${shortenAddress(txHash)}</a>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      const msg = (e as Error).message || t("stake.failedTitle");
      Swal.fire({
        icon: "error",
        title: t("error.title"),
        text: msg,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    }
  };

  if (!isConnected) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-white/50">
          {t("stake.recordsConnect")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("stake.recordsTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && orders.length === 0 ? (
          <div className="py-8 text-center text-white/40">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
          </div>
        ) : orders.length === 0 ? (
          <div className="py-8 text-center text-sm text-white/40">{t("stake.recordsEmpty")}</div>
        ) : (
          orders.map((o) => {
            const matured = serverNow != null && serverNow >= o.matures_at;
            const totalBps = o.monthly_rate_bps * o.lock_months;
            const principal = Number(formatUnits(BigInt(o.amount), 18));
            const yieldUsdt = (principal * totalBps) / 10_000;
            return (
              <div
                key={o.id}
                className={cn(
                  "rounded-xl border p-4 transition",
                  o.claimed
                    ? "border-white/5 bg-white/[0.02] opacity-60"
                    : matured
                      ? "border-[#00c6ff]/40 bg-[#00c6ff]/5"
                      : "border-white/10 bg-black/30",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-bold text-white">
                      {formatNumber(principal, 2)} {o.asset}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-white/50">
                      <span className="rounded-full border border-white/10 px-2 py-0.5">
                        {o.lock_months} {t("stake.month")}
                      </span>
                      <span>{bpsToPercent(o.monthly_rate_bps)} / {t("stake.month")}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-white/40">{t("stake.expectReturn")}</div>
                    <div className="font-bold text-[#b829ff]">
                      ≈ {formatNumber(principal, 2)} {o.asset} + {formatNumber(yieldUsdt, 2)} U
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-white/50">
                    {o.claimed ? (
                      <>
                        <CheckCircle className="h-3.5 w-3.5 text-green-400" />
                        {t("stake.claimed")}
                      </>
                    ) : matured ? (
                      <>
                        <CheckCircle className="h-3.5 w-3.5 text-[#00c6ff]" />
                        {t("stake.matured")}
                      </>
                    ) : (
                      <>
                        <Clock className="h-3.5 w-3.5" />
                        {t("stake.matures")} {new Date(o.matures_at * 1000).toLocaleDateString()}
                      </>
                    )}
                  </div>
                  {!o.claimed && matured && (
                    <Button size="sm" onClick={() => claim(o.id)}>
                      {t("stake.claimYield")}
                    </Button>
                  )}
                  {!o.claimed && !matured && (
                    <span className="flex items-center gap-1 text-xs text-white/30">
                      <Lock className="h-3 w-3" /> {t("stake.holding")}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
