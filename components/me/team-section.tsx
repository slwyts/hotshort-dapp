"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { Flame, Loader2, Sparkles, Users, Link2, WalletCards, type LucideIcon } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints, ApiError } from "@/lib/api";
import { VAULT_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { getStoredReferrer, clearStoredReferrer } from "@/components/referral-handler";
import { formatNumber, shortenAddress, cn } from "@/lib/utils";

interface TreeResp {
  counts: { gen1: number; gen2: number; gen3: number };
  members: { gen1: string[]; gen2: string[]; gen3: string[] };
  rewardsTotal: { usdtWei: string; stockWei: string; hsWei: string; count: number };
  rewardsPending?: { usdtWei: string; stockWei: string; hsWei: string; count: number };
}

interface MeResp {
  referrer: string | null;
  ancestors: { level1: string | null; level2: string | null; level3: string | null };
}

interface OwnerResp {
  owner: string;
}

interface ClaimSig {
  token?: string | null;
  tokens?: string[];
  recipients?: string[];
  amounts?: string[];
  amount: string;
  nonce?: string;
  deadline?: number;
  reason?: number;
  signature?: string;
}

const BIND_ERROR_KEY: Record<string, string> = {
  "referrer has no upline": "me.team.bindNoUpline",
  "circular referral": "me.team.bindCircular",
  "already bound": "me.team.bindAlreadyBound",
  "cannot refer self": "me.team.bindSelf",
  "invalid referrer": "me.team.bindInvalid",
  "invalid referral code": "me.team.bindInvalid",
};

function weiToNumber(value: string | null | undefined): number {
  try {
    return Number(formatUnits(BigInt(value ?? "0"), 18));
  } catch {
    return 0;
  }
}

function displayTx(hash: string | null | undefined): string {
  return hash && hash.startsWith("0x") ? shortenAddress(hash, 6) : "—";
}

function isReferralCode(value: string): boolean {
  return /^[A-Z0-9]{4,16}$/.test(value.toUpperCase());
}

export function TeamSection() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const { writeContractAsync } = useWriteContract();
  const { vault } = useContracts();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const [tree, setTree] = useState<TreeResp | null>(null);
  const [me, setMe] = useState<MeResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [refInput, setRefInput] = useState("");
  const [binding, setBinding] = useState(false);
  const [claimingDirect, setClaimingDirect] = useState(false);
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
    const raw = refInput.trim();
    const ref = raw.toLowerCase();
    const isWalletAddress = /^0x[a-f0-9]{40}$/.test(ref);
    if (!isWalletAddress && !isReferralCode(raw)) {
      await Swal.fire({ icon: "error", title: t("me.team.bindInvalid"), background: "#141419", color: "#fff" });
      return;
    }
    if (isWalletAddress && address && ref === address.toLowerCase()) {
      await Swal.fire({ icon: "error", title: t("me.team.bindSelf"), background: "#141419", color: "#fff" });
      return;
    }
    const token = jwt ?? (await signIn());
    if (!token) return;
    setBinding(true);
    try {
      await api.post(endpoints.referralBind, isWalletAddress ? { referrer: ref } : { referralCode: raw.toUpperCase() }, token);
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

  const sendVaultClaim = async (sig: ClaimSig): Promise<`0x${string}` | null> => {
    if (!sig.signature || !sig.token || !sig.recipients || !sig.amounts || !sig.nonce || !sig.deadline || sig.reason === undefined) {
      return null;
    }
    return writeContractAsync({
      address: vault,
      abi: VAULT_ABI,
      functionName: "claim",
      args: [
        (sig.tokens ?? sig.amounts.map(() => sig.token!)) as `0x${string}`[],
        sig.recipients as `0x${string}`[],
        sig.amounts.map((amount) => BigInt(amount)),
        BigInt(sig.nonce),
        BigInt(sig.deadline),
        sig.reason,
        sig.signature as `0x${string}`,
      ],
    });
  };

  const claimDirectReferral = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaimingDirect(true);
    try {
      Swal.fire({ title: t("me.team.claimPreparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<ClaimSig>(endpoints.aiReferralClaim, {}, token);
      if (!sig.signature || !sig.token || sig.amount === "0") {
        await Swal.fire({ icon: "info", title: t("me.team.claimNoRewardTitle"), text: t("me.team.claimNoRewardBody"), background: "#141419", color: "#fff" });
        return;
      }
      Swal.fire({ title: t("me.team.claimConfirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await sendVaultClaim(sig);
      await Swal.fire({
        icon: "success",
        title: t("me.team.claimSuccessTitle"),
        html: `${t("me.team.claimSuccessBody", { amount: formatNumber(weiToNumber(sig.amount), 2) })}<br/><span class="text-xs text-white/50">${displayTx(txHash)}</span>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      Swal.close();
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaimingDirect(false);
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

  const usdtRewards = weiToNumber(tree.rewardsTotal.usdtWei);
  const stockRewards = weiToNumber(tree.rewardsTotal.stockWei);
  const hsRewards = weiToNumber(tree.rewardsTotal.hsWei);
  const pendingDirectUsdt = weiToNumber(tree.rewardsPending?.usdtWei);
  const pendingStockRewards = weiToNumber(tree.rewardsPending?.stockWei);
  const pendingHsRewards = weiToNumber(tree.rewardsPending?.hsWei);
  const hasPendingDirectUsdt = pendingDirectUsdt > 0;
  const hasPendingStockRewards = pendingStockRewards > 0;
  const hasPendingHsRewards = pendingHsRewards > 0;

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
          <div className="mt-3 space-y-2">
            <RewardClaimItem
              icon={WalletCards}
              label={t("me.team.pendingDirectUsdt")}
              value={pendingDirectUsdt}
              unit="USDT"
              color="green"
              active={hasPendingDirectUsdt}
              buttonLabel={t("me.team.claimDirectUsdt")}
              loading={claimingDirect}
              disabled={claimingDirect || !hasPendingDirectUsdt}
              onClick={claimDirectReferral}
            />
            <RewardClaimItem
              icon={Sparkles}
              label={t("me.team.pendingStockReward")}
              value={pendingStockRewards}
              unit="FXHO"
              color="purple"
              active={hasPendingStockRewards}
              buttonLabel={t("me.team.claimStockReward")}
              disabled={!hasPendingStockRewards}
              onClick={() => router.push("/ai/dividend")}
            />
            <RewardClaimItem
              icon={Flame}
              label={t("me.team.pendingHsReward")}
              value={pendingHsRewards}
              unit="HS"
              color="cyan"
              active={hasPendingHsRewards}
              buttonLabel={t("me.team.claimHsReward")}
              disabled={!hasPendingHsRewards}
              onClick={() => router.push("/me?tab=orders&type=burn")}
            />
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
                placeholder={t("me.team.bindPlaceholder")}
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

function RewardClaimItem({
  icon: Icon,
  label,
  value,
  unit,
  color,
  active,
  buttonLabel,
  loading,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  unit: string;
  color: "green" | "purple" | "cyan";
  active: boolean;
  buttonLabel: string;
  loading?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const colors = {
    green: {
      shell: "border-[#22c55e]/25 bg-[#22c55e]/5",
      text: "text-[#22c55e]",
    },
    purple: {
      shell: "border-[#b829ff]/25 bg-[#b829ff]/5",
      text: "text-[#b829ff]",
    },
    cyan: {
      shell: "border-[#00c6ff]/25 bg-[#00c6ff]/5",
      text: "text-[#00c6ff]",
    },
  }[color];

  return (
    <div className={cn(
      "flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between",
      active ? colors.shell : "border-white/10 bg-white/[0.03]",
    )}>
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", active ? colors.text : "text-white/30")} />
        <div>
          <div className={cn("text-xs font-semibold", active ? "text-white" : "text-white/45")}>{label}</div>
          <div className={cn("text-sm font-black tabular-nums", active ? colors.text : "text-white/35")}>
            {formatNumber(value, 2)} {unit}
          </div>
        </div>
      </div>
      <Button
        onClick={onClick}
        disabled={disabled}
        size="sm"
        variant={active ? "default" : "outline"}
        className={!active ? "border-white/10 bg-white/5 text-white/35 shadow-none hover:border-white/10 hover:bg-white/5" : undefined}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : buttonLabel}
      </Button>
    </div>
  );
}
