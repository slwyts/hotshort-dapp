"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, parseUnits, keccak256, toHex } from "viem";
import { Loader2, ArrowDownUp } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageShell } from "@/components/page-shell";
import { AiSubnav } from "@/components/ai-subnav";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { useReferralGate } from "@/lib/hooks/use-referral-gate";
import { useEnsureAllowance } from "@/lib/hooks/use-ensure-allowance";
import { api, endpoints } from "@/lib/api";
import { ERC20_ABI, VAULT_ABI } from "@/lib/contracts/abis";
import { DEPOSIT_PURPOSE } from "@/lib/contracts/addresses";
import { useContracts } from "@/lib/runtime-config";
import { formatNumber } from "@/lib/utils";
import { WTO_TRADE_FEE_BPS, BPS_DENOMINATOR } from "@/lib/constants/business-rules";

export default function SwapPage() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { writeContractAsync } = useWriteContract();
  const { t } = useLocale();
  const { vault, hsToken } = useContracts();
  const { ensureBound } = useReferralGate();
  const ensureAllowance = useEnsureAllowance();
  const [hs, setHs] = useState("100");
  const [submitting, setSubmitting] = useState(false);
  const [hsPrice, setHsPrice] = useState<number | null>(null);
  const [stockPrice, setStockPrice] = useState<number | null>(null);

  const { data: hsBal } = useReadContract({
    abi: ERC20_ABI,
    address: hsToken,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const hsNum = hsBal ? Number(formatUnits(hsBal as bigint, 18)) : 0;

  useEffect(() => {
    void Promise.all([
      api.get<{ priceUsdt: number }>(endpoints.hsPrice).catch(() => ({ priceUsdt: 0.001 })),
      api.get<{ priceUsdt: number }>(endpoints.stockPrice).catch(() => ({ priceUsdt: 1 })),
    ]).then(([h, s]) => {
      setHsPrice(h.priceUsdt);
      setStockPrice(s.priceUsdt);
    });
  }, []);

  const stockOutGross =
    hsPrice && stockPrice && stockPrice > 0 ? (Number(hs) * hsPrice) / stockPrice : 0;
  const feePercent = WTO_TRADE_FEE_BPS / 100;
  const stockFee = (stockOutGross * WTO_TRADE_FEE_BPS) / BPS_DENOMINATOR;
  const stockOut = stockOutGross - stockFee;

  const submit = async () => {
    if (!isConnected || !address) {
      await Swal.fire({ icon: "warning", title: t("common.connectFirst"), background: "#141419", color: "#fff" });
      return;
    }
    const amountNum = Number(hs);
    if (!Number.isFinite(amountNum) || amountNum <= 0) return;
    if (hsNum < amountNum) {
      await Swal.fire({ icon: "warning", title: t("ai.swap.notEnough"), background: "#141419", color: "#fff" });
      return;
    }
    if (!(await ensureBound())) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSubmitting(true);
    try {
      const amountWei = parseUnits(hs, 18);
      Swal.fire({
        title: t("ai.swap.txApprove"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      await ensureAllowance({ token: hsToken, spender: vault, amount: amountWei });

      Swal.fire({
        title: t("ai.swap.txSwap"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      const ref = keccak256(toHex(`swap|${address}|${Date.now()}`));
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [hsToken, amountWei, DEPOSIT_PURPOSE.SWAP_HS_TO_STOCK, ref],
      });

      await api.post(endpoints.aiSwap, { sourceTxHash: txHash, hsAmountWei: amountWei.toString() }, token);

      await Swal.fire({
        icon: "success",
        title: t("ai.swap.success.title"),
        html: `${t("ai.swap.success.body", { amount: formatNumber(stockOut, 2) })}<br/>
               <a href="https://bscscan.com/tx/${txHash}" target="_blank" rel="noopener" class="text-[#00c6ff] text-xs">${t("ai.swap.success.viewTx")}</a>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
    } catch (e) {
      Swal.close();
      await Swal.fire({
        icon: "error",
        title: t("ai.swap.failed.title"),
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell>
      <h1 className="mb-1 text-xl font-black">{t("ai.title")}</h1>
      <p className="mb-3 text-xs text-white/50">{t("ai.subtitle.swap")}</p>
      <AiSubnav />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowDownUp className="h-5 w-5 text-[#b829ff]" /> {t("ai.swap.cardTitle")}
          </CardTitle>
          <CardDescription>{t("ai.swap.cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-2 block text-xs uppercase tracking-widest text-white/50">
              {t("ai.swap.payHs")}
            </label>
            <div className="relative">
              <Input
                value={hs}
                onChange={(e) => setHs(e.target.value)}
                placeholder="0.00"
                type="number"
                step="0.01"
                min="0"
                className="h-12 pr-24 text-base"
              />
              <button
                type="button"
                onClick={() => setHs(formatNumber(hsNum, 4))}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-[#b829ff]/40 bg-[#b829ff]/10 px-2 py-1 text-[10px] font-bold text-[#b829ff]"
              >
                MAX
              </button>
            </div>
            <div className="mt-1 text-[11px] text-white/40">
              {t("ai.swap.balance", { amount: formatNumber(hsNum, 2) })}
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-black/40 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-white/50">{t("ai.swap.hsPrice")}</span>
              <span className="font-bold text-[#00c6ff] tabular-nums">
                {hsPrice !== null ? `$${hsPrice.toFixed(4)}` : "—"}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-white/50">{t("ai.swap.stockPrice")}</span>
              <span className="font-bold text-white tabular-nums">
                {stockPrice !== null ? `$${stockPrice.toFixed(2)}` : "—"}
              </span>
            </div>
            <div className="mt-2.5 flex items-center justify-between border-t border-white/5 pt-2.5">
              <span className="text-white/50">{t("ai.swap.estimate")}</span>
              <span
                className="text-2xl font-black text-[#b829ff] tabular-nums"
                style={{ fontFamily: "Orbitron, sans-serif" }}
              >
                {formatNumber(stockOut, 2)} {t("ai.swap.unit.shares")}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px]">
              <span className="text-white/40">{t("ai.swap.fee", { percent: feePercent })}</span>
              <span className="text-white/50 tabular-nums">
                -{formatNumber(stockFee, 2)} {t("ai.swap.unit.shares")}
              </span>
            </div>
          </div>

          <div className="rounded-md border border-[#00c6ff]/30 bg-[#00c6ff]/5 px-3 py-2 text-[11px] text-[#00c6ff]">
            {t("ai.swap.availableHint")}
          </div>

          <Button onClick={submit} disabled={submitting} size="lg" className="w-full">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t("ai.swap.confirm")}
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
