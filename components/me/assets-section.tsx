"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { ERC20_ABI } from "@/lib/contracts/abis";
import { HS_TOKEN, USDT_TOKEN, PANCAKE_PAIR_HS_USDT } from "@/lib/contracts/addresses";
import { formatNumber } from "@/lib/utils";

interface Portfolio {
  stakeUsdt: string;
  aiPackageUsdt: string;
  stockUsdt: string;
  stockLockedUsdt: string;
  pendingUsdt: string;
  totalUsdt: string;
  pending: {
    stakeYield: string;
    lotteryPrize: string;
    aiDividend: string;
    burnTop10: string;
    referral: string;
  };
  hsPriceUsdt: number;
  stockPriceUsdt: number;
}

const TOKENS = [
  { key: "USDT", color: "#22c55e", address: USDT_TOKEN, descKey: "asset.usdt.desc" },
  { key: "HS", color: "#b829ff", address: HS_TOKEN, descKey: "asset.hs.desc" },
  { key: "LP", color: "#00c6ff", address: PANCAKE_PAIR_HS_USDT, descKey: "asset.lp.desc" },
] as const;

export function AssetsSection() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);

  const { data: usdtBal } = useReadContract({
    abi: ERC20_ABI,
    address: USDT_TOKEN as `0x${string}`,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const { data: hsBal } = useReadContract({
    abi: ERC20_ABI,
    address: HS_TOKEN as `0x${string}`,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const { data: lpBal } = useReadContract({
    abi: ERC20_ABI,
    address: PANCAKE_PAIR_HS_USDT as `0x${string}`,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  useEffect(() => {
    if (!isConnected) return;
    let cancel = false;
    (async () => {
      const token = jwt ?? (await signIn());
      if (!token || cancel) return;
      setLoading(true);
      try {
        const r = await api.get<Portfolio>(endpoints.portfolio, token);
        if (!cancel) setPortfolio(r);
      } catch {
        /* ignore */
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [isConnected, jwt, signIn]);

  if (!isConnected) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-white/50">{t("me.assets.connect")}</CardContent>
      </Card>
    );
  }

  const totalUsdt = portfolio ? Number(portfolio.totalUsdt) : 0;
  const stakeUsdt = portfolio ? Number(portfolio.stakeUsdt) : 0;
  const planUsdt = portfolio ? Number(portfolio.aiPackageUsdt) : 0;
  const stockUsdt = portfolio ? Number(portfolio.stockUsdt) : 0;
  const stockLockedUsdt = portfolio ? Number(portfolio.stockLockedUsdt) : 0;
  const pendingUsdt = portfolio ? Number(portfolio.pendingUsdt) : 0;
  const hsPrice = portfolio?.hsPriceUsdt ?? 0;

  const usdtNum = usdtBal ? Number(formatUnits(usdtBal as bigint, 18)) : 0;
  const hsNum = hsBal ? Number(formatUnits(hsBal as bigint, 18)) : 0;
  const lpNum = lpBal ? Number(formatUnits(lpBal as bigint, 18)) : 0;

  return (
    <div className="space-y-3">
      {/* DApp 总资产 */}
      <Card>
        <CardContent className="py-4 text-center">
          <div className="text-[11px] uppercase tracking-widest text-white/40">{t("me.assets.totalAssets")}</div>
          <div
            className="mt-1 text-3xl font-black tabular-nums neon-text"
            style={{ fontFamily: "Orbitron, sans-serif" }}
          >
            ${formatNumber(totalUsdt, 2)}
          </div>
          <div className="mt-1 text-[10px] text-white/40">{t("me.assets.totalAssetsHint")}</div>
        </CardContent>
      </Card>

      {/* DApp 资产分项 */}
      <Card>
        <CardContent className="py-3">
          <div className="mb-2 px-1 text-[10px] uppercase tracking-widest text-white/40">
            {t("me.assets.dappTitle")}
          </div>
          {loading && !portfolio ? (
            <div className="py-6 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" /></div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <DappCell label={t("me.assets.staked")} valueUsdt={stakeUsdt} color="#00c6ff" />
              <DappCell label={t("me.assets.plans")} valueUsdt={planUsdt} color="#b829ff" />
              <DappCell
                label={t("me.assets.stock")}
                valueUsdt={stockUsdt}
                hint={stockLockedUsdt > 0 ? `${t("me.assets.stockLocked")} $${formatNumber(stockLockedUsdt, 0)}` : undefined}
                color="#f59e0b"
              />
              <DappCell label={t("me.assets.pending")} valueUsdt={pendingUsdt} color="#22c55e" accent />
            </div>
          )}
        </CardContent>
      </Card>

      {/* 钱包余额 */}
      <Card>
        <CardContent className="py-3">
          <div className="mb-2 px-1 text-[10px] uppercase tracking-widest text-white/40">
            {t("me.assets.walletTitle")}
          </div>
          <div className="divide-y divide-white/5">
            {TOKENS.map((tk) => {
              const bal = tk.key === "USDT" ? usdtNum : tk.key === "HS" ? hsNum : lpNum;
              const price = tk.key === "USDT" ? 1 : tk.key === "HS" ? hsPrice : 0;
              const usdtEq = tk.key === "LP" ? null : bal * price;
              return (
                <div key={tk.key} className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-black"
                      style={{ background: `${tk.color}25`, color: tk.color }}
                    >
                      {tk.key.slice(0, 2)}
                    </div>
                    <div>
                      <div className="text-sm font-bold">{tk.key}</div>
                      <div className="text-[10px] text-white/40">{t(tk.descKey)}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold tabular-nums">{formatNumber(bal, 4)}</div>
                    {usdtEq !== null && (
                      <div className="text-[10px] text-white/40 tabular-nums">≈ ${formatNumber(usdtEq, 2)}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <p className="px-2 text-center text-[10px] text-white/30">
        {t("me.assets.note")}
      </p>
    </div>
  );
}

function DappCell({
  label,
  valueUsdt,
  hint,
  color,
  accent,
}: {
  label: string;
  valueUsdt: number;
  hint?: string;
  color: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-2.5 ${
        accent ? "border-[#22c55e]/30 bg-[#22c55e]/5" : "border-white/5 bg-black/40"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>
      </div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${accent ? "text-green-400" : "text-white"}`}>
        ${valueUsdt < 1 ? valueUsdt.toFixed(2) : formatNumber(valueUsdt, 0)}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-white/30">{hint}</div>}
    </div>
  );
}
