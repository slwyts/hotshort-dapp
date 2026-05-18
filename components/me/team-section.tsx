"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { Loader2, Users, Link2 } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints, ApiError } from "@/lib/api";
import { getStoredReferrer, clearStoredReferrer } from "@/components/referral-handler";
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

interface OwnerResp {
  owner: string;
}

const BIND_ERROR_KEY: Record<string, string> = {
  "referrer has no upline": "me.team.bindNoUpline",
  "circular referral": "me.team.bindCircular",
  "already bound": "me.team.bindAlreadyBound",
  "cannot refer self": "me.team.bindSelf",
  "invalid referrer": "me.team.bindInvalid",
};

export function TeamSection() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const [tree, setTree] = useState<TreeResp | null>(null);
  const [me, setMe] = useState<MeResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [refInput, setRefInput] = useState("");
  const [binding, setBinding] = useState(false);
  const [defaultReferrer, setDefaultReferrer] = useState<string | null>(null);

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

  useEffect(() => {
    void api
      .get<OwnerResp>(endpoints.referralOwner)
      .then((r) => setDefaultReferrer(r.owner.toLowerCase()))
      .catch(() => setDefaultReferrer(null));
  }, []);

  // 未绑定上级时，自动预填 URL ?ref= 带过来的地址
  useEffect(() => {
    if (me && !me.referrer && !refInput) {
      const stored = getStoredReferrer();
      if (stored) setRefInput(stored);
    }
  }, [me, refInput]);

  const bindReferrer = async () => {
    const ref = refInput.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(ref)) {
      await Swal.fire({ icon: "error", title: t("me.team.bindInvalid"), background: "#141419", color: "#fff" });
      return;
    }
    if (address && ref === address.toLowerCase()) {
      await Swal.fire({ icon: "error", title: t("me.team.bindSelf"), background: "#141419", color: "#fff" });
      return;
    }
    const token = jwt ?? (await signIn());
    if (!token) return;
    setBinding(true);
    try {
      await api.post(endpoints.referralBind, { referrer: ref }, token);
      await Swal.fire({
        icon: "success",
        title: t("me.team.bindSuccess"),
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
        timer: 1500,
      });
      setRefInput("");
      clearStoredReferrer();
      await refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      const key = BIND_ERROR_KEY[msg] ?? "me.team.bindFailed";
      await Swal.fire({
        icon: "error",
        title: t(key),
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setBinding(false);
    }
  };

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

      {me === null ? (
        <Card>
          <CardContent className="py-4 text-center text-xs text-white/40">
            {t("me.team.refLoadFailed")}
          </CardContent>
        </Card>
      ) : me.referrer ? (
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
      ) : (
        <Card>
          <CardContent className="py-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-white/40">
              <Link2 className="h-3 w-3" />
              {t("me.team.bindTitle")}
            </div>
            <p className="mb-3 text-[11px] text-white/40">{t("me.team.bindHint")}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={refInput}
                onChange={(e) => setRefInput(e.target.value)}
                placeholder="0x..."
                spellCheck={false}
                className="flex-1 rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#b829ff]"
              />
              <Button onClick={bindReferrer} disabled={binding || !refInput.trim()} size="sm">
                {binding ? <Loader2 className="h-4 w-4 animate-spin" /> : t("me.team.bindAction")}
              </Button>
            </div>
            {defaultReferrer && (
              <button
                type="button"
                onClick={() => setRefInput(defaultReferrer)}
                className="mt-2 text-[11px] text-[#00c6ff] underline-offset-2 hover:underline"
              >
                {t("me.team.bindUseDefault")}
              </button>
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
