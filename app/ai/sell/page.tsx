"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { ArrowDownUp, Loader2 } from "lucide-react";
import Swal from "sweetalert2";
import { PageShell } from "@/components/page-shell";
import { AiSubnav } from "@/components/ai-subnav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { VAULT_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { formatNumber, cn } from "@/lib/utils";

interface SellQuote {
  holdings: {
    totalStock: string;
    lockedStock: string;
    availableStock: string;
  };
  stockPriceUsdt: number;
  hsPriceUsdt: number;
  hsOut: string;
  usdtOut: string;
  enough: boolean;
}

interface SellResponse {
  id: string;
  stockIn: string;
  usdtOut: string;
  hsOut: string;
  stockPriceUsdt: number;
  hsPriceUsdt: number;
  token: string;
  tokens?: string[];
  recipients: string[];
  amounts: string[];
  amount: string;
  nonce: string;
  deadline: number;
  reason: number;
  signature: string;
  holdings: SellQuote["holdings"];
}

function weiToNumber(value: string) {
  return Number(formatUnits(BigInt(value || "0"), 18));
}

function weiToInputValue(value: string) {
  const text = formatUnits(BigInt(value || "0"), 18);
  return text.includes(".") ? text.replace(/\.?0+$/, "") || "0" : text;
}

export default function AiSellPage() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { writeContractAsync } = useWriteContract();
  const { t } = useLocale();
  const { vault } = useContracts();
  const [stockAmount, setStockAmount] = useState("10");
  const [quote, setQuote] = useState<SellQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const res = await api.get<SellQuote>(endpoints.aiSellQuote, token);
      setQuote(res);
    } catch {
      setQuote(null);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const available = quote ? weiToNumber(quote.holdings.availableStock) : 0;
  const locked = quote ? weiToNumber(quote.holdings.lockedStock) : 0;
  const total = quote ? weiToNumber(quote.holdings.totalStock) : 0;
  const amountNum = Number(stockAmount);
  const estimatedHs = useMemo(() => {
    if (!quote || !Number.isFinite(amountNum) || amountNum <= 0 || quote.hsPriceUsdt <= 0) return 0;
    return (amountNum * quote.stockPriceUsdt) / quote.hsPriceUsdt;
  }, [amountNum, quote]);
  const estimatedUsdt = quote && Number.isFinite(amountNum) && amountNum > 0 ? amountNum * quote.stockPriceUsdt : 0;
  const insufficient = Number.isFinite(amountNum) && amountNum > available;

  const submit = async () => {
    if (!isConnected) {
      await Swal.fire({ icon: "warning", title: t("common.connectFirst"), background: "#141419", color: "#fff" });
      return;
    }
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      await Swal.fire({ icon: "warning", title: t("ai.sell.invalid"), background: "#141419", color: "#fff" });
      return;
    }
    if (amountNum > available) {
      await Swal.fire({ icon: "warning", title: t("ai.sell.notEnough"), background: "#141419", color: "#fff" });
      return;
    }
    const token = jwt ?? (await signIn());
    if (!token) return;

    let sale: SellResponse | null = null;
    setSubmitting(true);
    try {
      const stockAmountWei = parseUnits(stockAmount, 18).toString();
      Swal.fire({ title: t("ai.sell.preparing"), background: "#141419", color: "#fff", allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      sale = await api.post<SellResponse>(endpoints.aiSell, { stockAmountWei }, token);
      const claimSale = sale;

      Swal.fire({ title: t("ai.sell.confirmWallet"), background: "#141419", color: "#fff", allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "claim",
        args: [
          (claimSale.tokens ?? claimSale.amounts.map(() => claimSale.token)) as `0x${string}`[],
          claimSale.recipients as `0x${string}`[],
          claimSale.amounts.map((amount) => BigInt(amount)),
          BigInt(claimSale.nonce),
          BigInt(claimSale.deadline),
          claimSale.reason,
          claimSale.signature as `0x${string}`,
        ],
      });

      await Swal.fire({
        icon: "success",
        title: t("ai.sell.success.title"),
        html: t("ai.sell.success.body", {
          stock: formatNumber(weiToNumber(sale.stockIn), 2),
          hs: formatNumber(weiToNumber(sale.hsOut), 4),
        }),
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      setStockAmount("10");
      await refresh();
    } catch (e) {
      Swal.close();
      await Swal.fire({
        icon: "error",
        title: t("ai.sell.failed.title"),
        text: sale ? t("ai.sell.failed.afterSigned") : (e as Error).message,
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
      <p className="mb-3 text-xs text-white/50">{t("ai.subtitle.sell")}</p>
      <AiSubnav />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowDownUp className="h-5 w-5 text-[#00c6ff]" /> {t("ai.sell.cardTitle")}
          </CardTitle>
          <CardDescription>{t("ai.sell.cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isConnected ? (
            <div className="py-10 text-center text-sm text-white/45">{t("ai.sell.connect")}</div>
          ) : loading || !quote ? (
            <div className="py-10 text-center text-white/40">
              <Loader2 className="mx-auto h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <Stat label={t("ai.sell.total")} value={formatNumber(total, 2)} unit="WTO" />
                <Stat label={t("ai.sell.available")} value={formatNumber(available, 2)} unit="WTO" accent />
                <Stat label={t("ai.sell.locked")} value={formatNumber(locked, 2)} unit="WTO" subtle />
              </div>

              <div>
                <label className="mb-2 block text-xs uppercase tracking-widest text-white/50">{t("ai.sell.amount")}</label>
                <div className="relative">
                  <Input
                    value={stockAmount}
                    onChange={(event) => setStockAmount(event.target.value)}
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    min="0"
                    className={cn("h-12 pr-24 text-base", insufficient && "border-red-400/50")}
                  />
                  <button
                    type="button"
                    onClick={() => setStockAmount(weiToInputValue(quote.holdings.availableStock))}
                    disabled={available <= 0}
                    className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-md border border-[#00c6ff]/40 bg-[#00c6ff]/10 px-2 py-1 text-[10px] font-bold text-[#00c6ff] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    MAX
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-white/40">{t("ai.sell.availableHint", { amount: formatNumber(available, 2) })}</div>
              </div>

              <div className="rounded-xl border border-white/5 bg-black/40 p-3 text-sm">
                <Row label={t("ai.sell.stockPrice")} value={`$${formatNumber(quote.stockPriceUsdt, 4)}`} accent />
                <Row label={t("ai.sell.hsPrice")} value={`$${formatNumber(quote.hsPriceUsdt, 6)}`} />
                <div className="my-2 border-t border-white/5" />
                <Row label={t("ai.sell.usdtValue")} value={`$${formatNumber(estimatedUsdt, 2)}`} />
                <Row label={t("ai.sell.estimateHs")} value={`${formatNumber(estimatedHs, 4)} HS`} strong />
              </div>

              <div className="rounded-md border border-[#b829ff]/30 bg-[#b829ff]/5 px-3 py-2 text-[11px] leading-relaxed text-[#dca8ff]">
                {t("ai.sell.priceHint")}
              </div>

              <Button onClick={submit} disabled={submitting || insufficient || available <= 0} size="lg" className="w-full">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {submitting ? t("common.processing") : t("ai.sell.confirm")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

function Row({ label, value, accent, strong }: { label: string; value: string; accent?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-white/50">{label}</span>
      <span className={cn("font-bold tabular-nums", accent ? "text-[#00c6ff]" : strong ? "text-[#b829ff]" : "text-white")}>{value}</span>
    </div>
  );
}

function Stat({ label, value, unit, accent, subtle }: { label: string; value: string; unit: string; accent?: boolean; subtle?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-2.5", accent ? "border-[#00c6ff]/30 bg-[#00c6ff]/5" : "border-white/5 bg-black/40")}>
      <div className="text-[10px] text-white/40">{label}</div>
      <div className={cn("mt-0.5 text-base font-black tabular-nums", accent ? "text-[#00c6ff]" : subtle ? "text-white/45" : "text-white")}>
        {value}<span className="ml-1 text-[9px] text-white/30">{unit}</span>
      </div>
    </div>
  );
}