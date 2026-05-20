"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { formatUnits, keccak256, toHex } from "viem";
import { Loader2, Ticket as TicketIcon, Trophy, Dice5, Plus, Trash2 } from "lucide-react";
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
import { DEPOSIT_PURPOSE } from "@/lib/contracts/addresses";
import { useContracts } from "@/lib/runtime-config";
import { LOTTERY_PRIZE_BPS, bpsToPercent } from "@/lib/constants/business-rules";
import { formatNumber, shortenAddress, cn } from "@/lib/utils";

interface Round {
  current: { roundNo: number; poolHs: string; ticketPriceHs: string };
  history: { round_no: number; winning_number: string; drawn_at: number; pool_hs: string }[];
  myTickets: {
    id: string;
    round_no: number;
    numbers: string;
    paid_hs: string;
    hit_digits: string | null;
    prize_hs: string | null;
    claimed: number;
    drawn_at: number | null;
    winning_number: string | null;
  }[];
}

const PRIZE_TABLE = [
  { key: "hit6All", labelKey: "lot.hit6", bps: LOTTERY_PRIZE_BPS.hit6All },
  { key: "hit5Prefix", labelKey: "lot.hit5", bps: LOTTERY_PRIZE_BPS.hit5Prefix },
  { key: "hit4Prefix", labelKey: "lot.hit4", bps: LOTTERY_PRIZE_BPS.hit4Prefix },
  { key: "hit3", labelKey: "lot.hit3", bps: LOTTERY_PRIZE_BPS.hit3 },
  { key: "hit2", labelKey: "lot.hit2", bps: LOTTERY_PRIZE_BPS.hit2 },
  { key: "hit1", labelKey: "lot.hit1", bps: LOTTERY_PRIZE_BPS.hit1 },
];

function randomNumbers(): string {
  return Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
}

export default function LotteryPage() {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { writeContractAsync } = useWriteContract();
  const { t } = useLocale();
  const { vault, hsToken } = useContracts();
  const { ensureBound } = useReferralGate();
  const ensureAllowance = useEnsureAllowance();
  const [data, setData] = useState<Round | null>(null);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<string[]>([randomNumbers()]);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    let token = jwt;
    if (!token && isConnected) token = await signIn();
    try {
      const r = await api.get<Round>(endpoints.lotteryRound, token ?? undefined);
      setData(r);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buy = async () => {
    if (!isConnected || !address) {
      await Swal.fire({ icon: "warning", title: t("common.connectFirst"), background: "#141419", color: "#fff" });
      return;
    }
    if (entries.length === 0 || entries.length > 100 || entries.some((numbers) => !/^\d{6}$/.test(numbers))) {
      await Swal.fire({ icon: "warning", title: t("lot.invalid"), background: "#141419", color: "#fff" });
      return;
    }
    if (!data) return;
    if (!(await ensureBound())) return;
    const token = jwt ?? (await signIn());
    if (!token) return;

    setSubmitting(true);
    try {
      const totalHsWei = BigInt(data.current.ticketPriceHs) * BigInt(entries.length);
      Swal.fire({
        title: t("lot.txApprove"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      await ensureAllowance({ token: hsToken, spender: vault, amount: totalHsWei });

      Swal.fire({
        title: t("lot.txBuy"),
        background: "#141419",
        color: "#fff",
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading(),
      });
      const ref = keccak256(toHex(`lottery|${address}|${entries.join(",")}|${data.current.roundNo}|${Date.now()}`));
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [hsToken, totalHsWei, DEPOSIT_PURPOSE.LOTTERY, ref],
      });

      await api.post(
        endpoints.lotteryBuy,
        {
          sourceTxHash: txHash,
          entries,
        },
        token,
      );

      await Swal.fire({
        icon: "success",
        title: t("lot.success.title", { count: entries.length }),
        html: `${t("lot.success.body", { numbers: entries.map((item) => `<strong style="color:#b829ff;font-family:monospace">${item}</strong>`).join(" / ") })}<br/>
               ${t("lot.success.next")}`,
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

  const claim = async (ticketId: string) => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    try {
      Swal.fire({ title: t("lot.claim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<{
        token: string;
        recipients: string[];
        amounts: string[];
        amount: string;
        nonce: string;
        deadline: number;
        reason: number;
        signature: string;
      }>(endpoints.lotteryClaim, { ticketId }, token);
      Swal.fire({ title: t("lot.claim.confirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "claim",
        args: [
          sig.token as `0x${string}`,
          sig.recipients as `0x${string}`[],
          sig.amounts.map((amount) => BigInt(amount)),
          BigInt(sig.nonce),
          BigInt(sig.deadline),
          sig.reason,
          sig.signature as `0x${string}`,
        ],
      });
      await Swal.fire({
        icon: "success",
        title: t("lot.claim.success.title"),
        html: `${t("lot.claim.success.body", { amount: formatNumber(Number(formatUnits(BigInt(sig.amount), 18)), 2) })}<br/>
               <a href="https://bscscan.com/tx/${txHash}" target="_blank" rel="noopener" class="text-[#00c6ff] text-xs">${shortenAddress(txHash)}</a>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  if (loading || !data) {
    return (
      <PageShell>
        <div className="py-20 text-center text-white/40">
          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
        </div>
      </PageShell>
    );
  }

  const poolHs = Number(formatUnits(BigInt(data.current.poolHs), 18));
  const ticketHs = Number(formatUnits(BigInt(data.current.ticketPriceHs), 18));
  const winnableTickets = data.myTickets.filter((t) => t.prize_hs && BigInt(t.prize_hs) > 0n && !t.claimed);

  const updateEntry = (index: number, value: string) => {
    setEntries((items) => items.map((item, i) => i === index ? value.replace(/\D/g, "").slice(0, 6) : item));
  };

  const randomEntry = (index: number) => {
    setEntries((items) => items.map((item, i) => i === index ? randomNumbers() : item));
  };

  const removeEntry = (index: number) => {
    setEntries((items) => items.length <= 1 ? items : items.filter((_, i) => i !== index));
  };

  return (
    <PageShell>
      {/* 大字奖池 */}
      <div className="mb-5 text-center">
        <div className="text-[10px] uppercase tracking-widest text-white/40">{t("lot.poolLabel", { round: data.current.roundNo })}</div>
        <div
          className="mt-1 text-5xl font-black neon-text tabular-nums"
          style={{ fontFamily: "Orbitron, sans-serif" }}
        >
          {formatNumber(poolHs, 0)}
        </div>
        <div className="mt-0.5 text-xs text-white/50">{t("lot.poolUnit")}</div>
      </div>

      {/* 选号 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TicketIcon className="h-5 w-5 text-[#b829ff]" /> {t("lot.buyTitle")}
          </CardTitle>
          <CardDescription>{t("lot.buyDesc", { price: formatNumber(ticketHs, 0) })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-2 block text-xs uppercase tracking-widest text-white/50">
              {t("lot.numbers")}
            </label>
            <div className="space-y-3">
              {entries.map((entry, index) => {
                const digits = entry.padEnd(6, " ").split("");
                return (
                  <div key={index} className="rounded-lg border border-white/5 bg-black/25 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-white/40">#{index + 1}</span>
                      <div className="flex gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => randomEntry(index)}>
                          <Dice5 className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => removeEntry(index)} disabled={entries.length <= 1}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-1.5">
                      {digits.map((d, i) => (
                        <div
                          key={i}
                          className="flex h-10 w-9 items-center justify-center rounded-lg border-2 border-white/10 bg-black/40 text-xl font-black text-white tabular-nums"
                          style={{ fontFamily: "Orbitron, sans-serif" }}
                        >
                          {d.trim()}
                        </div>
                      ))}
                    </div>
                    <Input
                      value={entry}
                      maxLength={6}
                      onChange={(e) => updateEntry(index, e.target.value)}
                      className="mt-2 h-10 text-center font-mono"
                      placeholder={t("lot.placeholder")}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEntries((items) => [...items, randomNumbers()].slice(0, 100))} className="flex-1">
                <Plus className="h-3.5 w-3.5" /> 添加一注
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEntries(entries.map(() => randomNumbers()))} className="flex-1">
                <Dice5 className="h-3.5 w-3.5" /> 全部随机
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-white/40">{t("lot.totalCost", { usdt: entries.length, hs: formatNumber(ticketHs * entries.length, 0) })}</p>
          </div>

          <Button onClick={buy} disabled={submitting} size="lg" className="w-full">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t("lot.confirm")}
          </Button>
        </CardContent>
      </Card>

      {/* 奖金分配 */}
      <Card className="mt-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-[#00c6ff]" /> {t("lot.prizeTitle")}
          </CardTitle>
          <CardDescription>{t("lot.prizeDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {PRIZE_TABLE.map((p) => (
              <div key={p.key} className="rounded-md border border-white/5 bg-black/40 p-2.5">
                <div className="text-[11px] text-white/50">{t(p.labelKey)}</div>
                <div className="text-base font-bold text-[#b829ff]">{bpsToPercent(p.bps)}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-white/30">
            {t("lot.prizeNote")}
          </p>
        </CardContent>
      </Card>

      {/* 中奖票 */}
      {winnableTickets.length > 0 && (
        <Card className="mt-3 border-[#b829ff]/40 bg-[#b829ff]/5">
          <CardHeader>
            <CardTitle>{t("lot.winnable.title", { n: winnableTickets.length })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {winnableTickets.map((ticket) => (
              <div key={ticket.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/40 p-2.5">
                <div>
                  <span className="font-mono text-sm font-bold tabular-nums" style={{ fontFamily: "Orbitron, sans-serif" }}>
                    {ticket.numbers}
                  </span>
                  <span className="ml-2 text-[10px] text-white/50">#{ticket.round_no}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-[#b829ff] tabular-nums">
                    {formatNumber(Number(formatUnits(BigInt(ticket.prize_hs!), 18)), 2)} HS
                  </span>
                  <Button size="sm" onClick={() => claim(ticket.id)}>{t("lot.claim")}</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 历史开奖（横向滑） */}
      <div className="mt-5 mb-2 flex items-center justify-between px-1">
        <span className="text-xs uppercase tracking-widest text-white/40">{t("lot.history")}</span>
      </div>
      {data.history.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-white/40">{t("lot.historyEmpty")}</CardContent>
        </Card>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 snap-x">
          <div className="flex gap-2 pb-2">
            {data.history.map((h) => (
              <div
                key={h.round_no}
                className="snap-start shrink-0 w-36 rounded-xl border border-white/10 bg-black/40 p-3"
              >
                <div className="text-[10px] text-white/40">#{h.round_no}</div>
                <div
                  className="mt-1 font-mono text-xl font-black tracking-widest text-[#00c6ff] tabular-nums"
                  style={{ fontFamily: "Orbitron, sans-serif" }}
                >
                  {h.winning_number}
                </div>
                <div className="mt-1.5 text-[9px] text-white/30">
                  {new Date(h.drawn_at * 1000).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 我的所有门票 */}
      {data.myTickets.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>{t("lot.myTickets")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.myTickets.slice(0, 30).map((ticket) => (
              <div key={ticket.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-black/30 p-2.5 text-xs">
                <div className="min-w-0 flex-1">
                  <span className="font-mono font-bold tabular-nums" style={{ fontFamily: "Orbitron, sans-serif" }}>
                    {ticket.numbers}
                  </span>
                  <span className="ml-2 text-white/40">#{ticket.round_no} {ticket.hit_digits ?? ""}</span>
                </div>
                <div className="text-right">
                  {ticket.prize_hs && BigInt(ticket.prize_hs) > 0n ? (
                    <span className={cn("font-bold tabular-nums", ticket.claimed ? "text-white/40" : "text-[#b829ff]")}>
                      +{formatNumber(Number(formatUnits(BigInt(ticket.prize_hs), 18)), 2)} HS
                    </span>
                  ) : !ticket.drawn_at ? (
                    <span className="text-[#00c6ff]">待开奖</span>
                  ) : (
                    <span className="text-white/30">{t("lot.notWin")}</span>
                  )}
                  {ticket.claimed ? <span className="ml-1 text-green-400">✓</span> : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
