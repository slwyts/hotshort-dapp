"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { Loader2, ArrowRight, Coins, Sparkles, Ticket, Flame } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { formatNumber, cn } from "@/lib/utils";

interface StakeOrder {
  id: string;
  asset: string;
  amount: string;
  lock_months: number;
  matures_at: number;
  claimed: number;
}
interface AiOrder {
  id: string;
  tier: string;
  usdt_in: string;
  created_at: number;
}
interface Ticket {
  id: string;
  round_no: number;
  numbers: string;
  prize_hs: string | null;
  claimed: number;
}
interface BurnMe {
  totalBurnedHs: string;
  out: boolean;
  top10PendingHs: string;
}

export function OrdersSection() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const [stake, setStake] = useState<StakeOrder[]>([]);
  const [ai, setAi] = useState<AiOrder[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [burnMe, setBurnMe] = useState<BurnMe | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const [s, a, l, b] = await Promise.all([
        api.get<{ orders: StakeOrder[] }>(endpoints.stakeOrders, token).catch(() => ({ orders: [] })),
        api.get<{ orders: AiOrder[] }>(endpoints.aiOrders, token).catch(() => ({ orders: [] })),
        api.get<{ myTickets: Ticket[] }>(endpoints.lotteryRound, token).catch(() => ({ myTickets: [] })),
        api.get<BurnMe>("/burn/me", token).catch(() => null),
      ]);
      setStake(s.orders ?? []);
      setAi(a.orders ?? []);
      setTickets(l.myTickets ?? []);
      setBurnMe(b);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!isConnected) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-white/50">{t("me.orders.connect")}</CardContent>
      </Card>
    );
  }
  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
        </CardContent>
      </Card>
    );
  }

  const claimableStake = stake.filter((o) => !o.claimed && Math.floor(Date.now() / 1000) >= o.matures_at).length;
  const winningTickets = tickets.filter((tk) => tk.prize_hs && BigInt(tk.prize_hs) > 0n && !tk.claimed).length;
  const top10Pending = burnMe ? Number(formatUnits(BigInt(burnMe.top10PendingHs), 18)) : 0;

  return (
    <div className="space-y-3">
      <SummaryRow
        href="/stake"
        icon={Coins}
        color="#00c6ff"
        title={t("me.orders.stake.title")}
        primary={t("me.orders.stake.count", { count: stake.length })}
        secondary={
          claimableStake > 0
            ? t("me.orders.stake.claimable", { n: claimableStake })
            : stake.length > 0
              ? t("me.orders.stake.holding")
              : t("me.orders.stake.empty")
        }
        accent={claimableStake > 0}
      />
      <SummaryRow
        href="/ai"
        icon={Sparkles}
        color="#b829ff"
        title={t("me.orders.ai.title")}
        primary={t("me.orders.ai.count", { count: ai.length })}
        secondary={
          ai.length > 0
            ? t("me.orders.ai.invested", {
                amount: formatNumber(
                  ai.reduce((s, o) => s + Number(formatUnits(BigInt(o.usdt_in), 18)), 0),
                  0,
                ),
              })
            : t("me.orders.stake.empty")
        }
      />
      <SummaryRow
        href="/lottery"
        icon={Ticket}
        color="#f59e0b"
        title={t("me.orders.lot.title")}
        primary={t("me.orders.lot.count", { count: tickets.length })}
        secondary={winningTickets > 0 ? t("me.orders.lot.win", { n: winningTickets }) : t("me.orders.lot.waiting")}
        accent={winningTickets > 0}
      />
      <SummaryRow
        href="/burn"
        icon={Flame}
        color="#ef4444"
        title={t("me.orders.burn.title")}
        primary={burnMe ? `${formatNumber(Number(formatUnits(BigInt(burnMe.totalBurnedHs), 18)), 0)} HS` : "0 HS"}
        secondary={
          top10Pending > 0
            ? t("me.orders.burn.weekly", { amount: formatNumber(top10Pending, 2) })
            : burnMe?.out
              ? t("me.orders.burn.done")
              : t("me.orders.burn.active")
        }
        accent={top10Pending > 0}
      />

      <p className="mt-2 px-2 text-center text-[10px] text-white/30">
        {t("me.orders.tap")}
      </p>
    </div>
  );
}

function SummaryRow({
  href,
  icon: Icon,
  color,
  title,
  primary,
  secondary,
  accent,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  title: string;
  primary: string;
  secondary: string;
  accent?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className={cn("transition active:scale-[0.99]", accent && "border-[#b829ff]/30 bg-[#b829ff]/5")}>
        <CardContent className="flex items-center gap-3 py-3.5">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{ background: `${color}25`, color }}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-bold">{title}</span>
              <span className="text-base font-black tabular-nums">{primary}</span>
            </div>
            <div className={cn("mt-0.5 text-[11px]", accent ? "text-[#b829ff]" : "text-white/50")}>
              {secondary}
            </div>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-white/30" />
        </CardContent>
      </Card>
    </Link>
  );
}
