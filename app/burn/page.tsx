"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { Loader2, Flame, Trophy, Send, Award } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageShell } from "@/components/page-shell";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { useReferralGate } from "@/lib/hooks/use-referral-gate";
import { useEnsureAllowance } from "@/lib/hooks/use-ensure-allowance";
import { api, endpoints } from "@/lib/api";
import { VAULT_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import {
  BURN_ALLOCATION_BPS,
  BURN_AIRDROP_MIN_USDT,
  BURN_PROMOTION_ACTIVATE_USDT,
  bpsToPercent,
} from "@/lib/constants/business-rules";
import { formatNumber, shortenAddress, cn } from "@/lib/utils";

interface BurnMe {
  totalBurnedHs: string;
  totalBurnedUsdt: string;
  personalCapUsdt: string;
  personalClaimedUsdt: string;
  personalClaimableUsdt: string;
  personalClaimed: boolean;
  out: boolean;
  promotionActive?: boolean;
  promotionActivationUsdt?: string;
  burnPendingUsdt: string;
  burnPendingHs: string;
  eligibleAirdrop: boolean;
  airdrop?: {
    hotshortAccount: string;
    status: "pending" | "sent" | "rejected";
    submittedAt: number;
  } | null;
}

interface Leaderboard {
  round: number;
  rows: { user: string; burn_hs: number | string; burn_usdt: number | string }[];
}

interface BurnRound {
  round: number;
  current: {
    totalBurnHs: string;
    totalBurnUsdt: string;
    weightPoolUsdt: string;
    promotionPoolUsdt: string;
    stakePoolUsdt: string;
    aiPoolUsdt: string;
    top10PoolUsdt: string;
    blackHoleUsdt: string;
    top10CarryoverUsdt: string;
  };
}

const ALLOC_TABLE = [
  { key: "blackHole", labelKey: "burn.alloc.blackHole", bps: BURN_ALLOCATION_BPS.blackHole },
  { key: "weight", labelKey: "burn.alloc.weight", bps: BURN_ALLOCATION_BPS.weight },
  { key: "promotion", labelKey: "burn.alloc.promotion", bps: BURN_ALLOCATION_BPS.promotion },
  { key: "stake", labelKey: "burn.alloc.stake", bps: BURN_ALLOCATION_BPS.stake },
  { key: "aiStock", labelKey: "burn.alloc.aiStock", bps: BURN_ALLOCATION_BPS.aiStock },
  { key: "top10", labelKey: "burn.alloc.top10", bps: BURN_ALLOCATION_BPS.top10 },
];

function weiToNumber(value: string | number | bigint | null | undefined): number {
  try {
    const text = String(value ?? "0");
    return /^\d+$/.test(text) ? Number(formatUnits(BigInt(text), 18)) : 0;
  } catch {
    return 0;
  }
}

function formatClaimAssetSummary(amounts: string[], tokens: string[], contracts: { usdtToken: string; hsToken: string }): string {
  const totals = new Map<string, bigint>();
  for (let index = 0; index < amounts.length; index++) {
    const token = tokens[index]?.toLowerCase();
    if (!token) continue;
    totals.set(token, (totals.get(token) ?? 0n) + BigInt(amounts[index]));
  }
  const labels = new Map<string, string>([
    [contracts.usdtToken.toLowerCase(), "USDT"],
    [contracts.hsToken.toLowerCase(), "HS"],
  ]);
  const parts = [...totals.entries()]
    .filter(([, amount]) => amount > 0n)
    .map(([token, amount]) => `${formatNumber(Number(formatUnits(amount, 18)), 2)} ${labels.get(token) ?? shortenAddress(token)}`);
  return parts.length > 0 ? parts.join(" + ") : "0 USDT";
}

function formatRewardPreview(usdt: number, hs = 0): string {
  const parts: string[] = [];
  if (usdt > 0 || hs <= 0) parts.push(`${formatNumber(usdt, 2)} USDT`);
  if (hs > 0) parts.push(`${formatNumber(hs, 2)} HS`);
  return parts.join(" + ");
}

export default function BurnPage() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { t } = useLocale();
  const { vault, hsToken, usdtToken } = useContracts();
  const { ensureBound } = useReferralGate();
  const ensureAllowance = useEnsureAllowance();

  const [me, setMe] = useState<BurnMe | null>(null);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [round, setRound] = useState<BurnRound | null>(null);
  const [loading, setLoading] = useState(false);
  const [hsAmount, setHsAmount] = useState("100");
  const [submitting, setSubmitting] = useState(false);
  const [claimingReward, setClaimingReward] = useState<"personal" | "weight" | null>(null);
  const [hotshortAccount, setHotshortAccount] = useState("");
  const [submittingAirdrop, setSubmittingAirdrop] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    let token = jwt;
    if (!token && isConnected) token = await signIn();
    try {
      const [m, lb, roundInfo] = await Promise.all([
        token ? api.get<BurnMe>("/burn/me", token) : Promise.resolve(null),
        api.get<Leaderboard>("/burn/leaderboard"),
        api.get<BurnRound>(endpoints.burnRound),
      ]);
      setMe(m);
      setBoard(lb);
      setRound(roundInfo);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const waitForSuccessfulTx = useCallback(async (hash: `0x${string}`) => {
    if (!publicClient) throw new Error(t("common.rpcUnavailable"));
    Swal.fire({ title: t("common.waitingOnChain"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(t("common.txFailedOnChain"));
  }, [publicClient, t]);

  const burn = async () => {
    if (!isConnected || !address) {
      await Swal.fire({ icon: "warning", title: t("common.connectFirst"), background: "#141419", color: "#fff" });
      return;
    }
    const num = Number(hsAmount);
    if (!Number.isFinite(num) || num <= 0) return;
    if (!(await ensureBound())) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSubmitting(true);
    try {
      const amountWei = parseUnits(hsAmount, 18);
      Swal.fire({ title: t("burn.txApprove"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      await ensureAllowance({ token: hsToken, spender: vault, amount: amountWei });

      Swal.fire({ title: t("burn.txBurn"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "burnHS",
        args: [hsToken, amountWei, "0x0000000000000000000000000000000000000000"],
      });

      await api.post(
        endpoints.burnRecord,
        {
          sourceTxHash: txHash,
          hsAmountWei: amountWei.toString(),
        },
        token,
      );

      await Swal.fire({
        icon: "success",
        title: t("burn.success.title"),
        html: `${t("burn.success.body", { amount: formatNumber(num, 2) })}<br/>
               <span class="text-xs text-white/50">${t("burn.success.note")}</span><br/>
               <a href="https://bscscan.com/tx/${txHash}" target="_blank" rel="noopener" class="text-[#00c6ff] text-xs">${shortenAddress(txHash)}</a>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      Swal.close();
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSubmitting(false);
    }
  };

  const claimTop10 = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaimingReward("weight");
    try {
      Swal.fire({ title: t("burn.claim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<{
        token?: string;
        tokens?: string[];
        recipients?: string[];
        amounts?: string[];
        amount: string;
        nonce?: string;
        deadline?: number;
        reason?: number;
        signature?: string;
      }>("/burn/claim/top10", {}, token);
      if (!sig.signature || !sig.token) {
        await Swal.fire({ icon: "info", title: t("burn.claim.noClaim.title"), text: t("burn.claim.noClaim.body"), background: "#141419", color: "#fff" });
        return;
      }
      Swal.fire({ title: t("burn.claim.confirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "claim",
        args: [
          (sig.tokens ?? sig.amounts!.map(() => sig.token!)) as `0x${string}`[],
          sig.recipients as `0x${string}`[],
          sig.amounts!.map((amount) => BigInt(amount)),
          BigInt(sig.nonce!),
          BigInt(sig.deadline!),
          sig.reason!,
          sig.signature as `0x${string}`,
        ],
      });
      await waitForSuccessfulTx(txHash);
      const claimTokens = sig.tokens ?? sig.amounts!.map(() => sig.token!);
      const claimedAssets = formatClaimAssetSummary(sig.amounts!, claimTokens, { usdtToken, hsToken });
      await Swal.fire({
        icon: "success",
        title: t("burn.claim.success.title"),
        html: `${t("burn.claim.success.body", { amount: claimedAssets })}<br/>
               <a href="https://bscscan.com/tx/${txHash}" target="_blank" class="text-[#00c6ff] text-xs">${shortenAddress(txHash)}</a>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaimingReward(null);
    }
  };

  const claimPersonal = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaimingReward("personal");
    try {
      Swal.fire({ title: t("burn.personalClaim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<{
        token?: string;
        tokens?: string[];
        recipients?: string[];
        amounts?: string[];
        amount: string;
        nonce?: string;
        deadline?: number;
        reason?: number;
        signature?: string;
      }>(endpoints.burnClaimPersonal, {}, token);
      if (!sig.signature || !sig.token) {
        await Swal.fire({ icon: "info", title: t("burn.claim.noClaim.title"), text: t("burn.personalClaim.noClaim"), background: "#141419", color: "#fff" });
        return;
      }
      Swal.fire({ title: t("burn.claim.confirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "claim",
        args: [
          (sig.tokens ?? sig.amounts!.map(() => sig.token!)) as `0x${string}`[],
          sig.recipients as `0x${string}`[],
          sig.amounts!.map((amount) => BigInt(amount)),
          BigInt(sig.nonce!),
          BigInt(sig.deadline!),
          sig.reason!,
          sig.signature as `0x${string}`,
        ],
      });
      await waitForSuccessfulTx(txHash);
      await api.post(endpoints.burnClaimPersonalConfirm, { txHash, nonce: sig.nonce }, token);
      await Swal.fire({
        icon: "success",
        title: t("burn.personalClaim.success.title"),
        html: `${t("burn.personalClaim.success.body", { amount: formatNumber(Number(formatUnits(BigInt(sig.amount), 18)), 2) })}<br/>
               <a href="https://bscscan.com/tx/${txHash}" target="_blank" rel="noopener" class="text-[#00c6ff] text-xs">${shortenAddress(txHash)}</a>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaimingReward(null);
    }
  };

  const submitAirdrop = async () => {
    if (!hotshortAccount.trim()) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setSubmittingAirdrop(true);
    try {
      await api.post("/burn/airdrop/submit", { hotshortAccount: hotshortAccount.trim() }, token);
      await Swal.fire({
        icon: "success",
        title: t("burn.airdropSubmitted.title"),
        text: t("burn.airdropSubmitted.body"),
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      setHotshortAccount("");
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSubmittingAirdrop(false);
    }
  };

  const totalBurn = weiToNumber(me?.totalBurnedHs);
  const totalBurnUsdt = weiToNumber(me?.totalBurnedUsdt);
  const burnPendingUsdt = weiToNumber(me?.burnPendingUsdt);
  const burnPendingHs = weiToNumber(me?.burnPendingHs);
  const personalClaimableUsdt = weiToNumber(me?.personalClaimableUsdt);
  const personalClaimedUsdt = weiToNumber(me?.personalClaimedUsdt);
  const currentWeeklyBurn = weiToNumber(round?.current?.totalBurnHs);
  const currentWeeklyBurnUsdt = weiToNumber(round?.current?.totalBurnUsdt);
  const currentTop10PoolUsdt = weiToNumber(round?.current?.top10PoolUsdt);
  const promotionActive = Boolean(me?.promotionActive || totalBurnUsdt >= BURN_PROMOTION_ACTIVATE_USDT);
  const airdropStatus = me?.airdrop?.status ?? "none";
  const canSubmitAirdrop = airdropStatus === "none" || airdropStatus === "rejected";
  const isOut = Boolean(me?.out || me?.personalClaimed);
  const hasOutWeightClaimable = burnPendingUsdt > 0 || burnPendingHs > 0;
  const canClaimPersonal = Boolean(me && !isOut && personalClaimableUsdt > 0);
  const canClaimOutWeight = Boolean(me && isOut && hasOutWeightClaimable);

  return (
    <PageShell>
      <div className="mb-4 text-center">
        <h1 className="text-3xl font-black flex items-center justify-center gap-2">
          <Flame className="h-8 w-8 text-[#ef4444]" />
          {t("burn.title")} <span className="neon-text">{t("burn.titleHighlight")}</span>
        </h1>
        <p className="mt-1 text-xs text-white/50">{t("burn.subtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flame className="h-5 w-5 text-[#ef4444]" /> {t("burn.cardTitle")}
          </CardTitle>
          <CardDescription>{t("burn.cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-2 block text-xs uppercase tracking-widest text-white/50">{t("burn.amount")}</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={hsAmount}
              onChange={(e) => setHsAmount(e.target.value)}
              placeholder="0.00"
              className="h-12 text-base"
            />
          </div>
          <Button onClick={burn} disabled={submitting} size="lg" className="w-full">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flame className="h-4 w-4" />}
            {t("burn.confirm")}
          </Button>

          {me && (
            <div className="grid grid-cols-2 gap-1.5 text-center">
              <Stat label={t("burn.stat.total")} value={formatNumber(totalBurn, 0)} unit="HS" />
              <Stat label={t("burn.stat.totalValue")} value={formatNumber(totalBurnUsdt, 2)} unit="USDT" />
              <Stat label={t("burn.stat.personalClaimable")} value={formatNumber(personalClaimableUsdt, 2)} unit="USDT" accent={!isOut} />
              <Stat label={t("burn.stat.personalCap")} value={formatNumber(weiToNumber(me.personalCapUsdt), 2)} unit="USDT" />
            </div>
          )}

          {me && (
            <div className="rounded-md border border-[#ef4444]/20 bg-[#ef4444]/5 px-3 py-2 text-[11px] leading-relaxed text-red-100/75">
              {me.out || me.personalClaimed
                ? t("burn.personalHint.done", { amount: formatNumber(personalClaimedUsdt, 2) })
                : t("burn.personalHint.active")}
            </div>
          )}

          {me && (
            <div className={cn(
              "rounded-md border px-3 py-2 text-[11px] leading-relaxed",
              promotionActive ? "border-[#00c6ff]/20 bg-[#00c6ff]/5 text-[#8fe7ff]" : "border-yellow-400/20 bg-yellow-400/5 text-yellow-100/75",
            )}>
              {promotionActive
                ? t("burn.promotion.active", { min: BURN_PROMOTION_ACTIVATE_USDT })
                : t("burn.promotion.inactive", { min: BURN_PROMOTION_ACTIVATE_USDT, usdt: formatNumber(totalBurnUsdt, 2) })}
            </div>
          )}

          {me && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <ClaimPreview
                  icon={<Flame className="h-3.5 w-3.5 text-[#ef4444]" />}
                  label={t("burn.claimPanel.personal")}
                  value={isOut ? t("burn.claimPanel.exited") : formatRewardPreview(personalClaimableUsdt)}
                  hint={t("burn.claimPanel.personalHint")}
                  active={!isOut && personalClaimableUsdt > 0}
                />
                <ClaimPreview
                  icon={<Award className="h-3.5 w-3.5 text-[#b829ff]" />}
                  label={t("burn.claimPanel.weight")}
                  value={isOut ? formatRewardPreview(burnPendingUsdt, burnPendingHs) : t("burn.claimPanel.afterExit")}
                  hint={t("burn.claimPanel.weightHint")}
                  active={canClaimOutWeight}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={claimPersonal}
                  disabled={!canClaimPersonal || claimingReward !== null}
                  variant="outline"
                  className="min-w-0 border-[#ef4444]/40 px-2 text-xs text-red-100 hover:bg-[#ef4444]/10"
                >
                  {claimingReward === "personal" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flame className="h-4 w-4 shrink-0" />}
                  <span className="min-w-0 truncate">
                    {isOut ? t("burn.claimPersonalDone") : personalClaimableUsdt > 0 ? t("burn.claimPersonal") : t("burn.claimPersonalPending")}
                  </span>
                </Button>
                <Button
                  onClick={claimTop10}
                  disabled={!canClaimOutWeight || claimingReward !== null}
                  variant="outline"
                  className="min-w-0 px-2 text-xs"
                >
                  {claimingReward === "weight" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Award className="h-4 w-4 shrink-0" />}
                  <span className="min-w-0 truncate">
                    {!isOut ? t("burn.claimWeightLocked") : hasOutWeightClaimable ? t("burn.claimWeekly") : t("burn.claimWeeklyPending")}
                  </span>
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-3">
        <CardHeader>
          <CardTitle>{t("burn.allocTitle")}</CardTitle>
          <CardDescription>{t("burn.allocDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Stat label={t("burn.pendingBurnTotal")} value={formatNumber(currentWeeklyBurn, 0)} unit="HS" accent />
            <Stat label={t("burn.pendingBurnValue")} value={formatNumber(currentWeeklyBurnUsdt, 2)} unit="USDT" />
            <Stat label={t("burn.top10Pool")} value={formatNumber(currentTop10PoolUsdt, 2)} unit="USDT" />
          </div>
          <div className="mb-3 rounded-md border border-[#00c6ff]/20 bg-[#00c6ff]/5 px-3 py-2 text-[11px] leading-relaxed text-[#8fe7ff]">
            {t("burn.poolHint", { activate: BURN_PROMOTION_ACTIVATE_USDT })}
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-sm">
            {ALLOC_TABLE.map((a) => (
              <div key={a.key} className="rounded-md border border-white/5 bg-black/40 p-2.5">
                <div className="text-[10px] text-white/50">{t(a.labelKey)}</div>
                <div className={cn("text-base font-bold tabular-nums", a.key === "blackHole" ? "text-red-400" : "text-[#b829ff]")}>
                  {bpsToPercent(a.bps)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-yellow-400" /> {t("burn.boardTitle", { round: board?.round ?? "—" })}
          </CardTitle>
          <CardDescription>{t("burn.boardDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" />
          ) : (board?.rows ?? []).length === 0 ? (
            <div className="py-6 text-center text-sm text-white/40">暂无数据</div>
          ) : (
            <div className="space-y-1.5">
              {board!.rows.slice(0, 20).map((r, i) => (
                <div
                  key={r.user}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2 py-2 text-sm",
                    i < 10 && "bg-[#b829ff]/5",
                    r.user.toLowerCase() === address?.toLowerCase() && "ring-1 ring-[#00c6ff]/40 bg-[#00c6ff]/10",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold tabular-nums",
                        i === 0 && "bg-yellow-500/20 text-yellow-400",
                        i === 1 && "bg-gray-300/20 text-gray-300",
                        i === 2 && "bg-orange-500/20 text-orange-300",
                        i > 2 && "bg-white/5 text-white/50",
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="font-mono text-xs">{shortenAddress(r.user, 4)}</span>
                  </div>
                  <span className="font-bold tabular-nums">
                    {formatNumber(weiToNumber(r.burn_usdt), 2)} <span className="text-xs text-white/40">USDT</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {me && me.eligibleAirdrop && (
        <Card className="mt-3 border-[#b829ff]/40 bg-[#b829ff]/5">
          <CardHeader>
            <CardTitle>{t("burn.airdropTitle")}</CardTitle>
            <CardDescription>
              {t("burn.airdropDesc", { min: BURN_AIRDROP_MIN_USDT, usdt: formatNumber(totalBurnUsdt, 2) })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!canSubmitAirdrop && me.airdrop ? (
              <div className={cn(
                "rounded-md border px-3 py-2 text-sm leading-relaxed",
                airdropStatus === "sent"
                  ? "border-green-400/25 bg-green-400/10 text-green-100"
                  : "border-[#00c6ff]/25 bg-[#00c6ff]/10 text-[#8fe7ff]",
              )}>
                <div className="font-bold">
                  {t(airdropStatus === "sent" ? "burn.airdrop.status.sent" : "burn.airdrop.status.pending")}
                </div>
                <div className="mt-1 text-xs opacity-80">
                  {t("burn.airdrop.account", { account: me.airdrop.hotshortAccount })}
                </div>
              </div>
            ) : (
              <>
                {airdropStatus === "rejected" && (
                  <div className="rounded-md border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-red-100">
                    {t("burn.airdrop.status.rejected")}
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    placeholder={t("burn.airdropPlaceholder")}
                    value={hotshortAccount}
                    onChange={(e) => setHotshortAccount(e.target.value)}
                    className="flex-1"
                  />
                  <Button onClick={submitAirdrop} disabled={submittingAirdrop || !hotshortAccount.trim()}>
                    {submittingAirdrop ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}

function Stat({ label, value, unit, accent, subtle }: { label: string; value: string; unit: string; accent?: boolean; subtle?: boolean }) {
  return (
    <div className={cn("rounded-md border p-2", accent ? "border-[#b829ff]/30 bg-[#b829ff]/5" : "border-white/5 bg-black/30")}>
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      <div className={cn("mt-1 text-base font-bold", accent ? "text-[#b829ff]" : subtle ? "text-white/60" : "text-white")}>
        {value} <span className="text-xs text-white/40">{unit}</span>
      </div>
    </div>
  );
}

function ClaimPreview({ icon, label, value, hint, active }: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
  active?: boolean;
}) {
  return (
    <div className={cn("rounded-md border bg-black/30 p-2", active ? "border-[#b829ff]/30 bg-[#b829ff]/5" : "border-white/5")}>
      <div className="flex items-center gap-1.5 text-[10px] text-white/45">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn("mt-1 truncate text-sm font-black tabular-nums", active ? "text-[#b829ff]" : "text-white/75")}>{value}</div>
      <div className="mt-0.5 truncate text-[10px] text-white/35">{hint}</div>
    </div>
  );
}
