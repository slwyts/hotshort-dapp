"use client";

import { useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { parseUnits, keccak256, toHex } from "viem";
import { Loader2, Layers, ArrowRight } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/components/locale-provider";
import { ERC20_ABI, VAULT_ABI } from "@/lib/contracts/abis";
import { DEPOSIT_PURPOSE } from "@/lib/contracts/addresses";
import { useContracts } from "@/lib/runtime-config";
import {
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  STAKE_DEFAULT_RATES_BPS,
  bpsToPercent,
  type StakeAsset,
  type StakeLockMonths,
} from "@/lib/constants/business-rules";
import { cn } from "@/lib/utils";

interface StakeFormProps {
  /** 已发送 deposit 后的回调，把 txHash 传出去入库 */
  onDeposited: (info: {
    asset: StakeAsset;
    amountWei: bigint;
    lockMonths: StakeLockMonths;
    txHash: `0x${string}`;
  }) => void;
}

export function StakeForm({ onDeposited }: StakeFormProps) {
  const { address, isConnected } = useAccount();
  const { t } = useLocale();
  const { writeContractAsync } = useWriteContract();
  const { vault, hsToken, usdtToken, pancakePair } = useContracts();

  const ASSET_TOKEN: Record<StakeAsset, `0x${string}`> = {
    USDT: usdtToken,
    HS: hsToken,
    LP: pancakePair,
  };

  const [asset, setAsset] = useState<StakeAsset>("USDT");
  const [lockMonths, setLockMonths] = useState<StakeLockMonths>(3);
  const [amount, setAmount] = useState("100");
  const [submitting, setSubmitting] = useState(false);

  const monthlyBps = STAKE_DEFAULT_RATES_BPS[asset][lockMonths];
  const totalReturnBps = monthlyBps * lockMonths;

  const submit = async () => {
    if (!isConnected || !address) {
      await swalError(t("common.connectFirst"));
      return;
    }
    if (vault === "0x0000000000000000000000000000000000000000") {
      await swalError(t("common.coming"));
      return;
    }
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      await swalError(t("stake.invalid"));
      return;
    }
    setSubmitting(true);
    try {
      const token = ASSET_TOKEN[asset];
      const amountWei = parseUnits(amount, 18);

      // 1) approve
      Swal.fire({
        title: t("stake.txCommon"),
        text: t("stake.claim.confirm"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      await writeContractAsync({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vault, amountWei],
      });

      // 2) deposit
      Swal.fire({
        title: t("stake.txDeposit"),
        text: t("stake.txConfirmInWallet"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      const ref = keccak256(
        toHex(`stake|${address}|${asset}|${lockMonths}|${Date.now()}`),
      );
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [token, amountWei, DEPOSIT_PURPOSE.STAKE, ref],
      });

      onDeposited({ asset, amountWei, lockMonths, txHash });
      Swal.close();
    } catch (e) {
      Swal.close();
      const msg = (e as Error).message || t("error.title");
      await swalError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-[#00c6ff]" />
          {t("stake.formTitle")}
        </CardTitle>
        <CardDescription>{t("stake.formDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div>
          <label className="mb-2 block text-xs uppercase tracking-widest text-white/50">
            {t("stake.asset")}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {STAKE_ASSETS.map((a) => (
              <button
                key={a}
                onClick={() => setAsset(a)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm font-bold transition",
                  asset === a
                    ? "border-[#b829ff]/60 bg-[#b829ff]/10 text-white"
                    : "border-white/10 bg-white/5 text-white/60 hover:border-white/20",
                )}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs uppercase tracking-widest text-white/50">
            {t("stake.lockPeriod")}
          </label>
          <div className="grid grid-cols-4 gap-2">
            {STAKE_LOCK_MONTHS.map((m) => (
              <button
                key={m}
                onClick={() => setLockMonths(m)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm font-bold transition",
                  lockMonths === m
                    ? "border-[#00c6ff]/60 bg-[#00c6ff]/10 text-white"
                    : "border-white/10 bg-white/5 text-white/60 hover:border-white/20",
                )}
              >
                {m} {t("stake.month")}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs uppercase tracking-widest text-white/50">
            {t("stake.amount")}
          </label>
          <div className="relative">
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              type="number"
              step="0.01"
              min="0"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/40">
              {asset}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-white/5 bg-black/40 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-white/50">{t("stake.monthlyApy")}</span>
            <span className="font-bold text-[#00c6ff]">{bpsToPercent(monthlyBps)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-white/50">{t("stake.totalReturn", { months: lockMonths })}</span>
            <span className="font-bold text-[#b829ff]">{bpsToPercent(totalReturnBps)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-white/40">{t("stake.payInHs")}</span>
            <span className="text-white/40">{t("stake.fuelFee")}</span>
          </div>
          {lockMonths >= 6 && (
            <div className="mt-2 rounded-md border border-[#b829ff]/30 bg-[#b829ff]/5 px-3 py-2 text-xs text-[#b829ff]">
              {t("stake.bonusTip")}
            </div>
          )}
        </div>

        <Button onClick={submit} disabled={submitting} size="lg" className="w-full">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submitting ? t("common.processing") : t("stake.confirm")}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

async function swalError(msg: string) {
  await Swal.fire({
    icon: "error",
    title: msg,
    background: "#141419",
    color: "#fff",
    confirmButtonColor: "#b829ff",
  });
}
