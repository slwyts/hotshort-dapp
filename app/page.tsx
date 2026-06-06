"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import {
  Coins,
  Sparkles,
  Ticket,
  Flame,
  Users,
  Megaphone,
  ArrowRight,
  TrendingUp,
  Wallet,
  HelpCircle,
} from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { ERC20_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { formatNumber, cn } from "@/lib/utils";

interface Portfolio {
  stakeUsdt: string;
  aiPackageUsdt: string;
  stockUsdt: string;
  pendingUsdt: string;
  totalUsdt: string;
  raw?: {
    stockTotalWei?: string;
  };
}
interface RoundResp {
  current: { roundNo: number; poolHs: string; ticketPriceHs: string };
}

function weiToNumber(value: string | null | undefined): number {
  try {
    return Number(formatUnits(BigInt(value ?? "0"), 18));
  } catch {
    return 0;
  }
}

function formatStockShares(value: number, unit: string): string {
  const amount = formatNumber(value, value >= 100 ? 0 : 4);
  return unit === "股" ? `${amount}${unit}` : `${amount} ${unit}`;
}

export default function HomePage() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const { hsToken, usdtToken, pancakePair } = useContracts();
  const [hsPrice, setHsPrice] = useState<number | null>(null);
  const [poolHs, setPoolHs] = useState<number | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [todayDividend, setTodayDividend] = useState<number>(0);
  const [stockPriceForDividend, setStockPriceForDividend] = useState<number | null>(null);

  // 钱包余额
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

  // 公共数据
  useEffect(() => {
    void Promise.all([
      api.get<{ priceUsdt: number }>(endpoints.hsPrice).catch(() => null),
      api.get<{ priceUsdt: number }>(endpoints.stockPrice).catch(() => null),
      api.get<RoundResp>(endpoints.lotteryRound).catch(() => null),
    ]).then(([hp, sp, lr]) => {
      if (hp) setHsPrice(hp.priceUsdt);
      if (sp) setStockPriceForDividend(sp.priceUsdt);
      if (lr) setPoolHs(Number(formatUnits(BigInt(lr.current.poolHs), 18)));
    });
  }, []);

  // 私有数据：DApp 资产聚合 + 今日分红
  useEffect(() => {
    if (!isConnected) return;
    let cancel = false;
    (async () => {
      let token = jwt;
      if (!token) token = await signIn();
      if (!token || cancel) return;
      try {
        const [p, d] = await Promise.all([
          api.get<Portfolio>(endpoints.portfolio, token).catch(() => null),
          api.get<{ dividend: { stock_share: string } }>(endpoints.aiDividendToday, token).catch(() => null),
        ]);
        if (cancel) return;
        if (p) setPortfolio(p);
        if (d) setTodayDividend(Number(formatUnits(BigInt(d.dividend.stock_share || "0"), 18)));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancel = true;
    };
  }, [isConnected, jwt, signIn]);

  const _usdtNum = usdtBal ? Number(formatUnits(usdtBal as bigint, 18)) : 0;
  const _hsNum = hsBal ? Number(formatUnits(hsBal as bigint, 18)) : 0;
  const _lpNum = lpBal ? Number(formatUnits(lpBal as bigint, 18)) : 0;

  // 总资产 = DApp 内合计（来自 /portfolio.totalUsdt）
  const totalUsdt = portfolio ? Number(portfolio.totalUsdt) : 0;
  const stakeUsdt = portfolio ? Number(portfolio.stakeUsdt) : 0;
  const aiPackageUsdt = portfolio ? Number(portfolio.aiPackageUsdt) : 0;
  const stockShares = portfolio ? weiToNumber(portfolio.raw?.stockTotalWei) : 0;
  const pendingUsdt = portfolio ? Number(portfolio.pendingUsdt) : 0;

  const todayDividendUsdt = stockPriceForDividend ? todayDividend * stockPriceForDividend : 0;

  return (
    <PageShell>
      {/* 资产卡 */}
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-gradient-to-br from-[#b829ff] to-[#00c6ff] opacity-20 blur-2xl" />
        <CardContent className="relative space-y-4 pt-5">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-white/40">{t("home.totalAssets")}</div>
            <div
              className="mt-1 text-3xl font-black tabular-nums"
              style={{ fontFamily: "Orbitron, sans-serif" }}
            >
              {isConnected
                ? `$${formatNumber(totalUsdt, 2)}`
                : <span className="text-white/40">— {t("home.totalAssetsHint")} —</span>}
            </div>
            {isConnected && todayDividendUsdt > 0 && (
              <div className="mt-1 flex items-center gap-1 text-xs text-green-400">
                <TrendingUp className="h-3 w-3" /> {t("home.todayProfit")} +${formatNumber(todayDividendUsdt, 2)}
              </div>
            )}
          </div>

          {isConnected && (
            <div className="grid grid-cols-4 gap-1.5 text-center">
              <Mini label={t("home.dapp.staked")} value={`$${formatNumber(stakeUsdt, 0)}`} />
              <Mini label={t("home.dapp.plans")} value={`$${formatNumber(aiPackageUsdt, 0)}`} />
              <Mini label={t("home.dapp.stock")} value={formatStockShares(stockShares, t("asset.stock.unit"))} accent />
              <Mini label={t("home.dapp.pending")} value={`$${formatNumber(pendingUsdt, 2)}`} />
            </div>
          )}

          <div className="flex gap-2">
            <Link href="/burn" className="flex-1">
              <Button className="w-full" size="md">
                <Flame className="h-4 w-4" /> {t("home.action.burn")}
              </Button>
            </Link>
            <Link href="/ai" className="flex-1">
              <Button variant="outline" className="w-full" size="md">
                <Sparkles className="h-4 w-4" /> {t("home.action.plans")}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* 行情卡 */}
      <Card className="mt-3">
        <CardContent className="flex items-center justify-between py-4">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-white/40">{t("home.hsPrice")}</div>
            <div className="mt-0.5 text-xl font-bold tabular-nums">
              {hsPrice !== null ? `$${hsPrice.toFixed(4)}` : "—"}
            </div>
          </div>
          <div className="h-10 w-px bg-white/5" />
          <div>
            <div className="text-[11px] uppercase tracking-widest text-white/40">{t("home.weeklyPool")}</div>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="text-xl font-bold text-[#b829ff] tabular-nums">
                {poolHs !== null ? formatNumber(poolHs, 0) : "—"}
              </span>
              <span className="text-xs text-white/40">HS</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 快捷入口 */}
      <div className="mt-5 mb-2 flex items-center justify-between px-1">
        <span className="text-xs uppercase tracking-widest text-white/40">{t("home.shortcuts")}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <ShortcutCard href="/stake" icon={Coins} label={t("home.shortcut.stake")} color="#b829ff" />
        <ShortcutCard href="/me?tab=team" icon={Users} label={t("home.shortcut.team")} color="#00c6ff" />
        <ShortcutCard href="/me?tab=assets" icon={Wallet} label={t("home.shortcut.assets")} color="#b829ff" />
        <ShortcutCard href="/lottery" icon={Ticket} label={t("home.shortcut.lottery")} color="#f59e0b" />
        <ShortcutCard href="/ai/dividend" icon={Sparkles} label={t("home.shortcut.dividend")} color="#14b8a6" />
        <ShortcutCard href="/me?tab=invite" icon={HelpCircle} label={t("home.shortcut.invite")} color="#8b5cf6" />
      </div>

      {/* 公告条 */}
      <Card className="mt-4 border-[#b829ff]/30 bg-[#b829ff]/5">
        <Link href="/ai" className="block">
          <CardContent className="flex items-center gap-3 py-3">
            <Megaphone className="h-4 w-4 shrink-0 text-[#b829ff]" />
            <div className="flex-1 truncate text-xs">
              <span className="font-bold text-white">{t("home.notice.title")}</span>
              <span className="ml-2 text-white/50">{t("home.notice.body")}</span>
            </div>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-white/40" />
          </CardContent>
        </Link>
      </Card>

      {/* 主推位 */}
      <div className="mt-5 mb-2 flex items-center justify-between px-1">
        <span className="text-xs uppercase tracking-widest text-white/40">{t("home.recommended")}</span>
      </div>
      <Link href="/ai">
        <Card className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#b829ff]/20 via-transparent to-[#00c6ff]/20" />
          <CardContent className="relative flex items-center gap-3 py-4">
            <Image
              src="/mascots/moon.png"
              alt=""
              width={56}
              height={56}
              className="animate-float"
            />
            <div className="flex-1">
              <div className="text-base font-bold">{t("home.feature.title")}</div>
              <div className="mt-0.5 text-xs text-white/50">{t("home.feature.body")}</div>
            </div>
            <ArrowRight className="h-4 w-4 text-white/40" />
          </CardContent>
        </Card>
      </Link>
    </PageShell>
  );
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-white/5 bg-black/30 px-1 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-white/40">{label}</div>
      <div
        className={cn(
          "text-xs font-bold tabular-nums truncate",
          accent ? "text-[#b829ff]" : "text-white/90",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ShortcutCard({
  href,
  icon: Icon,
  label,
  color,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  color: string;
}) {
  return (
    <Link href={href}>
      <div className="glass-panel flex flex-col items-center gap-1.5 rounded-2xl border border-white/5 px-2 py-3.5 transition active:scale-95">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-xl"
          style={{
            background: `linear-gradient(135deg, ${color}40, ${color}10)`,
            boxShadow: `0 4px 12px ${color}30`,
          }}
        >
          <Icon className="h-5 w-5" />
        </div>
        <span className="text-[11px] font-medium text-white/80">{label}</span>
      </div>
    </Link>
  );
}
