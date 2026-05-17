"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { Loader2, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api } from "@/lib/api";
import { formatNumber, shortenAddress, cn } from "@/lib/utils";

interface TreeResp {
  counts: { gen1: number; gen2: number; gen3: number };
  members: { gen1: string[]; gen2: string[]; gen3: string[] };
  rewardsTotal: { usdtWei: string; stockWei: string; hsWei: string; count: number };
}

interface MeResp {
  referrer: string | null;
  ancestors: { level1: string | null; level2: string | null; level3: string | null };
}

export function TeamSection() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const [tree, setTree] = useState<TreeResp | null>(null);
  const [me, setMe] = useState<MeResp | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const [t, m] = await Promise.all([
        api.get<TreeResp>("/referral/tree", token).catch(() => null),
        api.get<MeResp>("/referral/me", token).catch(() => null),
      ]);
      setTree(t);
      setMe(m);
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
        <CardContent className="py-12 text-center text-sm text-white/50">{t("common.connectFirst")}</CardContent>
      </Card>
    );
  }
  if (loading || !tree) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
        </CardContent>
      </Card>
    );
  }

  const usdtRewards = Number(BigInt(tree.rewardsTotal.usdtWei)) / 1e18;
  const stockRewards = Number(BigInt(tree.rewardsTotal.stockWei)) / 1e18;
  const hsRewards = Number(BigInt(tree.rewardsTotal.hsWei)) / 1e18;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="py-4">
          <div className="mb-3 text-[11px] uppercase tracking-widest text-white/40">{t("me.team.title")}</div>
          <div className="grid grid-cols-3 gap-2">
            <GenCard label={t("me.team.gen1")} count={tree.counts.gen1} accent />
            <GenCard label={t("me.team.gen2")} count={tree.counts.gen2} />
            <GenCard label={t("me.team.gen3")} count={tree.counts.gen3} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <div className="mb-3 text-[11px] uppercase tracking-widest text-white/40">
            {t("me.team.rewardsTotal", { count: tree.rewardsTotal.count })}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border border-white/5 bg-black/40 p-2">
              <div className="text-[10px] text-white/40">USDT</div>
              <div className="mt-0.5 text-base font-bold tabular-nums">{formatNumber(usdtRewards, 2)}</div>
            </div>
            <div className="rounded-lg border border-[#b829ff]/30 bg-[#b829ff]/5 p-2">
              <div className="text-[10px] text-white/40">{t("asset.stock")}</div>
              <div className="mt-0.5 text-base font-bold text-[#b829ff] tabular-nums">{formatNumber(stockRewards, 2)}</div>
            </div>
            <div className="rounded-lg border border-white/5 bg-black/40 p-2">
              <div className="text-[10px] text-white/40">HS</div>
              <div className="mt-0.5 text-base font-bold tabular-nums">{formatNumber(hsRewards, 2)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {me && me.referrer && (
        <Card>
          <CardContent className="py-4">
            <div className="mb-2 text-[11px] uppercase tracking-widest text-white/40">{t("me.team.refer")}</div>
            <div className="font-mono text-xs text-white/70">{shortenAddress(me.referrer, 8)}</div>
            {me.ancestors.level2 && (
              <div className="mt-1 text-[10px] text-white/30 font-mono">
                {t("me.team.referLevel2")} {shortenAddress(me.ancestors.level2, 6)}
              </div>
            )}
            {me.ancestors.level3 && (
              <div className="mt-0.5 text-[10px] text-white/30 font-mono">
                {t("me.team.referLevel3")} {shortenAddress(me.ancestors.level3, 6)}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tree.members.gen1.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-widest text-white/40">
              <Users className="h-3 w-3" />
              {t("me.team.directInvites")} ({tree.members.gen1.length})
            </div>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {tree.members.gen1.map((addr) => (
                <div key={addr} className="flex items-center justify-between rounded-md border border-white/5 bg-black/30 px-3 py-2 text-xs">
                  <span className="font-mono">{shortenAddress(addr, 6)}</span>
                  <span className="text-white/30">{t("me.team.joined")}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {tree.counts.gen1 + tree.counts.gen2 + tree.counts.gen3 === 0 && (
        <p className="px-2 text-center text-xs text-white/40">
          {t("me.team.empty")}
        </p>
      )}
    </div>
  );
}

function GenCard({ label, count, accent }: { label: string; count: number; accent?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-3 text-center", accent ? "border-[#b829ff]/30 bg-[#b829ff]/5" : "border-white/5 bg-black/40")}>
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      <div className={cn("mt-1 text-2xl font-black tabular-nums", accent ? "text-[#b829ff]" : "text-white")}>
        {count}
      </div>
    </div>
  );
}
