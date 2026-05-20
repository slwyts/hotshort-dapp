"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract } from "wagmi";
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
  bpsToPercent,
} from "@/lib/constants/business-rules";
import { formatNumber, shortenAddress, cn } from "@/lib/utils";

interface BurnMe {
  totalBurnedHs: string;
  personalClaimedHs: string;
  out: boolean;
  top10PendingHs: string;
  eligibleAirdrop: boolean;
}

interface Leaderboard {
  round: number;
  rows: { user: string; burn_hs: number | string }[];
}

interface BurnRound {
  round: number;
  current: {
    totalBurnHs: string;
    weightPoolHs: string;
    promotionPoolHs: string;
    stakePoolHs: string;
    aiPoolHs: string;
    top10PoolHs: string;
    blackHoleHs: string;
    top10CarryoverHs: string;
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

export default function BurnPage() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { writeContractAsync } = useWriteContract();
  const { t } = useLocale();
  const { vault, hsToken } = useContracts();
  const { ensureBound } = useReferralGate();
  const ensureAllowance = useEnsureAllowance();

  const [me, setMe] = useState<BurnMe | null>(null);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [round, setRound] = useState<BurnRound | null>(null);
  const [loading, setLoading] = useState(false);
  const [hsAmount, setHsAmount] = useState("100");
  const [submitting, setSubmitting] = useState(false);
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
    try {
      Swal.fire({ title: t("burn.claim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<{
        token?: string;
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
          sig.token as `0x${string}`,
          sig.recipients as `0x${string}`[],
          sig.amounts!.map((amount) => BigInt(amount)),
          BigInt(sig.nonce!),
          BigInt(sig.deadline!),
          sig.reason!,
          sig.signature as `0x${string}`,
        ],
      });
      await Swal.fire({
        icon: "success",
        title: t("burn.claim.success.title"),
        html: `${t("burn.claim.success.body", { amount: formatNumber(Number(formatUnits(BigInt(sig.amount), 18)), 2) })}<br/>
               <a href="https://bscscan.com/tx/${txHash}" target="_blank" class="text-[#00c6ff] text-xs">${shortenAddress(txHash)}</a>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
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
    } catch (e) {
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setSubmittingAirdrop(false);
    }
  };

  const totalBurn = me ? Number(formatUnits(BigInt(me.totalBurnedHs), 18)) : 0;
  const top10Pending = me ? Number(formatUnits(BigInt(me.top10PendingHs), 18)) : 0;
  const currentWeeklyBurn = round ? Number(formatUnits(BigInt(round.current.totalBurnHs), 18)) : 0;
  const currentTop10Pool = round ? Number(formatUnits(BigInt(round.current.top10PoolHs), 18)) : 0;

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
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <Stat label={t("burn.stat.total")} value={formatNumber(totalBurn, 0)} unit="HS" />
              <Stat label={t("burn.stat.claimable")} value={formatNumber(top10Pending, 2)} unit="HS" accent />
              <Stat label={t("burn.stat.status")} value={me.out ? t("burn.status.done") : t("burn.status.active")} unit="" subtle />
            </div>
          )}

          {me && top10Pending > 0 && (
            <Button onClick={claimTop10} variant="outline" className="w-full">
              <Award className="h-4 w-4" /> {t("burn.claimWeekly")}
            </Button>
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
            <Stat label="本周总奖池" value={formatNumber(currentWeeklyBurn, 0)} unit="HS" accent />
            <Stat label="Top10 周池" value={formatNumber(currentTop10Pool, 2)} unit="HS" />
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
                    {formatNumber(Number(BigInt(String(r.burn_hs))) / 1e18, 2)}
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
              {t("burn.airdropDesc", { min: BURN_AIRDROP_MIN_USDT, hs: formatNumber(totalBurn, 0) })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              placeholder={t("burn.airdropPlaceholder")}
              value={hotshortAccount}
              onChange={(e) => setHotshortAccount(e.target.value)}
              className="flex-1"
            />
            <Button onClick={submitAirdrop} disabled={submittingAirdrop || !hotshortAccount.trim()}>
              {submittingAirdrop ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
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
