"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { ChevronRight, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { ERC20_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { cn, formatNumber } from "@/lib/utils";
import { ReferrerBindCard } from "@/components/me/referrer-bind-card";

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

type TokenKey = "USDT" | "HS" | "LP";

export function AssetsSection() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const { hsToken, usdtToken, pancakePair } = useContracts();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);

  const TOKENS: { key: TokenKey; color: string; address: `0x${string}`; descKey: string }[] = [
    { key: "USDT", color: "#22c55e", address: usdtToken, descKey: "asset.usdt.desc" },
    { key: "HS", color: "#b829ff", address: hsToken, descKey: "asset.hs.desc" },
    { key: "LP", color: "#00c6ff", address: pancakePair, descKey: "asset.lp.desc" },
  ];

  const { data: usdtBal } = useReadContract({
    abi: ERC20_ABI,
    address: usdtToken,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const { data: hsBal } = useReadContract({
    abi: ERC20_ABI,
    address: hsToken,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const { data: lpBal } = useReadContract({
    abi: ERC20_ABI,
    address: pancakePair,
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
  const referralPendingUsdt = portfolio ? Number(portfolio.pending.referral) : 0;
  const pendingHref = referralPendingUsdt > 0 ? "/me?tab=team" : "/me?tab=orders";
  const hsPrice = portfolio?.hsPriceUsdt ?? 0;

  const usdtNum = usdtBal ? Number(formatUnits(usdtBal as bigint, 18)) : 0;
  const hsNum = hsBal ? Number(formatUnits(hsBal as bigint, 18)) : 0;
  const lpNum = lpBal ? Number(formatUnits(lpBal as bigint, 18)) : 0;

  return (
    <div className="space-y-3">
      <ReferrerBindCard />

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
              <DappCell label={t("me.assets.staked")} valueUsdt={stakeUsdt} color="#00c6ff" href="/me?tab=orders&type=stake" />
              <DappCell label={t("me.assets.plans")} valueUsdt={planUsdt} color="#b829ff" href="/me?tab=orders&type=ai" />
              <DappCell
                label={t("me.assets.stock")}
                valueUsdt={stockUsdt}
                hint={stockLockedUsdt > 0 ? `${t("me.assets.stockLocked")} $${formatNumber(stockLockedUsdt, 0)}` : undefined}
                color="#f59e0b"
                href="/ai/dividend"
              />
              <DappCell label={t("me.assets.pending")} valueUsdt={pendingUsdt} color="#22c55e" accent href={pendingHref} />
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
                    <TokenIcon token={tk.key} />
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

function TokenIcon({ token }: { token: TokenKey }) {
  if (token === "HS") {
    return (
      <div className="relative h-8 w-8 overflow-hidden rounded-full border border-[#f7d56a]/50 bg-white shadow-[0_0_18px_rgba(184,41,255,0.28)]">
        <Image src="/mascots/logo.png" alt="HS" fill sizes="32px" className="object-cover" />
      </div>
    );
  }

  if (token === "LP") {
    return (
      <div className="relative flex h-8 w-8 items-center justify-center rounded-full border border-cyan-300/35 bg-[#03141f] shadow-[0_0_18px_rgba(0,198,255,0.22)]">
        <svg viewBox="0 0 32 32" aria-label="HS-USDT LP" className="h-8 w-8" role="img">
          <defs>
            <linearGradient id="lpHsGradient" x1="5" y1="5" x2="19" y2="21" gradientUnits="userSpaceOnUse">
              <stop stopColor="#d83a87" />
              <stop offset="1" stopColor="#00c6ff" />
            </linearGradient>
            <linearGradient id="lpRingGradient" x1="10" y1="8" x2="28" y2="26" gradientUnits="userSpaceOnUse">
              <stop stopColor="#2bf7c4" />
              <stop offset="1" stopColor="#00a3ff" />
            </linearGradient>
          </defs>
          <circle cx="12.5" cy="13.5" r="9" fill="url(#lpHsGradient)" />
          <circle cx="19.5" cy="18.5" r="9" fill="#26a17b" stroke="#bfffee" strokeWidth="1.4" />
          <path d="M15.2 15.4h8.6v1.9h-3.2v1.2c2.2.1 3.8.4 3.8.9s-2.2 1-4.9 1-4.9-.5-4.9-1c0-.5 1.6-.8 3.8-.9v-1.2h-3.2v-1.9Zm3.2 3.8c-1.2.1-2 .2-2.3.3.5.2 1.7.3 3.4.3s2.9-.1 3.4-.3c-.3-.1-1.1-.2-2.3-.3v.6h-2.2v-.6Z" fill="white" />
          <path d="M8.2 11.5c.8-1.7 2.5-2.9 4.5-2.9 1.6 0 3 .7 3.9 1.8" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" />
          <path d="M16.9 7.7v3.2h-3.2" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
          <path d="M23.9 22.1a8.6 8.6 0 0 1-11.9 0" fill="none" stroke="url(#lpRingGradient)" strokeLinecap="round" strokeWidth="1.6" />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-emerald-200/40 bg-[#26a17b] shadow-[0_0_18px_rgba(34,197,94,0.24)]">
      <svg viewBox="0 0 32 32" aria-label="USDT" className="h-8 w-8" role="img">
        <circle cx="16" cy="16" r="15" fill="#26A17B" />
        <circle cx="16" cy="16" r="13" fill="none" stroke="#8ff5d2" strokeOpacity="0.35" strokeWidth="1" />
        <path d="M8 8.3h16v3.2h-6.3v2.2c4.2.2 7.3.9 7.3 1.8 0 .9-3.1 1.6-7.3 1.8v6.4h-3.4v-6.4C10.1 17.1 7 16.4 7 15.5c0-.9 3.1-1.6 7.3-1.8v-2.2H8V8.3Zm6.3 6.9c-2.7.1-4.6.3-5.5.6.9.4 3.7.7 7.2.7s6.3-.3 7.2-.7c-.9-.3-2.8-.5-5.5-.6v1.1h-3.4v-1.1Z" fill="white" />
      </svg>
    </div>
  );
}

function DappCell({
  label,
  valueUsdt,
  hint,
  color,
  accent,
  href,
}: {
  label: string;
  valueUsdt: number;
  hint?: string;
  color: string;
  accent?: boolean;
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
          <span className="min-w-0 truncate text-[10px] uppercase tracking-wider text-white/40">{label}</span>
        </div>
        {href && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/30 transition-colors group-hover:text-white/65" />}
      </div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${accent ? "text-green-400" : "text-white"}`}>
        ${valueUsdt < 1 ? valueUsdt.toFixed(2) : formatNumber(valueUsdt, 0)}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-white/30">{hint}</div>}
    </>
  );
  const className = cn(
    "group block rounded-xl border p-2.5 transition-colors",
    accent ? "border-[#22c55e]/30 bg-[#22c55e]/5" : "border-white/5 bg-black/40",
    href && "hover:border-white/15 hover:bg-white/[0.06]",
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }

  return (
    <div className={className}>
      {body}
    </div>
  );
}
