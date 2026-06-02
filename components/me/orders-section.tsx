"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { Award, CheckCircle, ChevronDown, Clock, Coins, Flame, Loader2, Sparkles, Ticket } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { VAULT_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { useServerTime } from "@/hooks/use-server-time";
import { bpsToPercent } from "@/lib/constants/business-rules";
import { cn, formatNumber, shortenAddress } from "@/lib/utils";

type OrderType = "stake" | "ai" | "lottery" | "burn";

interface StakeOrder {
  id: string;
  asset: string;
  amount: string;
  lock_months: number;
  monthly_rate_bps: number;
  started_at: number;
  matures_at: number;
  claimed: number;
  claim_tx_hash: string | null;
  source_tx_hash: string;
}

interface AiRelease {
  release_index: number;
  stock_amount: string;
  unlocks_at: number;
  released_at: number | null;
}

interface AiOrder {
  id: string;
  tier: string;
  usdt_in: string;
  stock_granted: string;
  released_stock: string;
  locked_stock: string;
  next_unlocks_at: number | null;
  releases: AiRelease[];
  created_at: number;
  source_tx_hash: string;
}

interface TicketOrder {
  id: string;
  round_no: number;
  numbers: string;
  paid_hs: string;
  hit_digits: string | null;
  prize_hs: string | null;
  claimed: number;
  drawn_at: number | null;
  winning_number: string | null;
}

interface BurnMe {
  totalBurnedHs: string;
  totalBurnedUsdt: string;
  personalClaimedHs: string;
  personalClaimableHs: string;
  personalClaimed: boolean;
  out: boolean;
  top10PendingHs: string;
  pendingBreakdown?: {
    top10Hs: string;
    weightHs: string;
    promotionHs: string;
    stakeHs: string;
    aiHs: string;
  };
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

interface BurnRecord {
  id: string;
  hs_amount: string;
  settled_round: number | null;
  claimed_individual: number;
  burned_at: number;
  source_tx_hash: string;
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
  claimableHs?: string;
  fuelBurnHs?: string;
}

const ORDER_TYPES: { key: OrderType; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { key: "stake", icon: Coins, label: "质押" },
  { key: "ai", icon: Sparkles, label: "套餐" },
  { key: "lottery", icon: Ticket, label: "彩票" },
  { key: "burn", icon: Flame, label: "燃烧" },
];

function weiToNumber(value: string | null | undefined): number {
  try {
    return Number(formatUnits(BigInt(value ?? "0"), 18));
  } catch {
    return 0;
  }
}

function dateText(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("zh-CN");
}

function displayTx(hash: string | null | undefined): string {
  return hash && hash.startsWith("0x") ? shortenAddress(hash, 6) : "—";
}

export function OrdersSection() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { vault } = useContracts();
  const activeType = (ORDER_TYPES.some((item) => item.key === search.get("type")) ? search.get("type") : "stake") as OrderType;

  const [stake, setStake] = useState<StakeOrder[]>([]);
  const [ai, setAi] = useState<AiOrder[]>([]);
  const [tickets, setTickets] = useState<TicketOrder[]>([]);
  const [burnMe, setBurnMe] = useState<BurnMe | null>(null);
  const [burnRound, setBurnRound] = useState<BurnRound | null>(null);
  const [burnRecords, setBurnRecords] = useState<BurnRecord[]>([]);
  const [stockPrice, setStockPrice] = useState<number>(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);

  const switchType = (type: OrderType) => {
    const params = new URLSearchParams(search.toString());
    params.set("tab", "orders");
    params.set("type", type);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    setExpanded(null);
  };

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLoading(true);
    try {
      const [s, a, lot, b, br, records, quote] = await Promise.all([
        api.get<{ orders: StakeOrder[] }>(endpoints.stakeOrders, token).catch(() => ({ orders: [] })),
        api.get<{ orders: AiOrder[] }>(endpoints.aiOrders, token).catch(() => ({ orders: [] })),
        api.get<{ myTickets: TicketOrder[] }>(endpoints.lotteryRound, token).catch(() => ({ myTickets: [] })),
        api.get<BurnMe>("/burn/me", token).catch(() => null),
        api.get<BurnRound>(endpoints.burnRound).catch(() => null),
        api.get<{ records: BurnRecord[] }>(endpoints.burnRecords, token).catch(() => ({ records: [] })),
        api.get<{ priceUsdt: number }>(endpoints.stockPrice).catch(() => ({ priceUsdt: 1 })),
      ]);
      setStake(s.orders ?? []);
      setAi(a.orders ?? []);
      setTickets(lot.myTickets ?? []);
      setBurnMe(b);
      setBurnRound(br);
      setBurnRecords(records.records ?? []);
      setStockPrice(quote.priceUsdt || 1);
    } finally {
      setLoading(false);
    }
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sendVaultClaim = async (sig: ClaimSig): Promise<`0x${string}` | null> => {
    if (!sig.signature || !sig.token || !sig.recipients || !sig.amounts || !sig.nonce || !sig.deadline || sig.reason === undefined) {
      return null;
    }
    if (!publicClient) throw new Error(t("common.rpcUnavailable"));
    const txHash = await writeContractAsync({
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
    Swal.fire({ title: t("common.waitingOnChain"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(t("common.txFailedOnChain"));
    return txHash;
  };

  const claimStake = async (orderId: string) => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaiming(orderId);
    try {
      Swal.fire({ title: t("stake.claim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<ClaimSig>(endpoints.stakeClaim, { orderId }, token);
      Swal.fire({ title: t("stake.claim.confirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await sendVaultClaim(sig);
      api.post(endpoints.stakeConfirm, { orderId, txHash }, token).catch((e: unknown) => console.error("stake confirm failed", e));
      await Swal.fire({
        icon: "success",
        title: t("stake.claim.successTitle"),
        html: `${t("stake.claim.successBody", { amount: formatNumber(weiToNumber(sig.claimableHs), 4) })}<br/><span class="text-xs text-white/50">${t("stake.claim.fuelNote", { amount: formatNumber(weiToNumber(sig.fuelBurnHs), 4) })}</span><br/><span class="text-xs text-white/40">${displayTx(txHash)}</span>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      Swal.close();
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaiming(null);
    }
  };

  const claimLottery = async (ticketId: string) => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaiming(ticketId);
    try {
      Swal.fire({ title: t("lot.claim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<ClaimSig>(endpoints.lotteryClaim, { ticketId }, token);
      Swal.fire({ title: t("lot.claim.confirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await sendVaultClaim(sig);
      api.post(endpoints.lotteryConfirm, { ticketId, txHash }, token).catch((e: unknown) => console.error("lottery confirm failed", e));
      await Swal.fire({
        icon: "success",
        title: t("lot.claim.success.title"),
        html: `${t("lot.claim.success.body", { amount: formatNumber(weiToNumber(sig.amount), 2) })}<br/><span class="text-xs text-white/50">${displayTx(txHash)}</span>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      Swal.close();
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaiming(null);
    }
  };

  const claimBurn = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaiming("burn");
    try {
      Swal.fire({ title: t("burn.claim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<ClaimSig>(endpoints.burnClaim, {}, token);
      if (!sig.signature || !sig.token || sig.amount === "0") {
        await Swal.fire({ icon: "info", title: t("burn.claim.noClaim.title"), text: t("burn.claim.noClaim.body"), background: "#141419", color: "#fff" });
        return;
      }
      Swal.fire({ title: t("burn.claim.confirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await sendVaultClaim(sig);
      await Swal.fire({
        icon: "success",
        title: t("burn.claim.success.title"),
        html: `${t("burn.claim.success.body", { amount: formatNumber(weiToNumber(sig.amount), 2) })}<br/><span class="text-xs text-white/50">${displayTx(txHash)}</span>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      Swal.close();
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaiming(null);
    }
  };

  const claimPersonalBurn = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setClaiming("burn-personal");
    try {
      Swal.fire({ title: t("burn.personalClaim.preparing"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const sig = await api.post<ClaimSig>(endpoints.burnClaimPersonal, {}, token);
      Swal.fire({ title: t("burn.claim.confirm"), background: "#141419", color: "#fff", didOpen: () => Swal.showLoading() });
      const txHash = await sendVaultClaim(sig);
      await api.post(endpoints.burnClaimPersonalConfirm, { txHash, nonce: sig.nonce }, token);
      await Swal.fire({
        icon: "success",
        title: t("burn.personalClaim.success.title"),
        html: `${t("burn.personalClaim.success.body", { amount: formatNumber(weiToNumber(sig.amount), 2) })}<br/><span class="text-xs text-white/50">${displayTx(txHash)}</span>`,
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
      });
      await refresh();
    } catch (e) {
      Swal.close();
      await Swal.fire({ icon: "error", title: t("error.title"), text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally {
      setClaiming(null);
    }
  };

  if (!isConnected) {
    return <Card><CardContent className="py-12 text-center text-sm text-white/50">{t("me.orders.connect")}</CardContent></Card>;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-1 rounded-xl border border-white/5 bg-black/40 p-1">
        {ORDER_TYPES.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => switchType(key)}
            className={cn(
              "flex min-h-10 items-center justify-center gap-1 rounded-lg px-1 text-xs font-bold transition",
              activeType === key ? "bg-[#b829ff]/20 text-white ring-1 ring-[#b829ff]/40" : "text-white/45",
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <Card><CardContent className="py-12 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-white/40" /></CardContent></Card>
      ) : activeType === "stake" ? (
        <StakeOrders orders={stake} expanded={expanded} setExpanded={setExpanded} claimStake={claimStake} claiming={claiming} />
      ) : activeType === "ai" ? (
        <AiOrders orders={ai} expanded={expanded} setExpanded={setExpanded} stockPrice={stockPrice} />
      ) : activeType === "lottery" ? (
        <LotteryOrders tickets={tickets} expanded={expanded} setExpanded={setExpanded} claimLottery={claimLottery} claiming={claiming} />
      ) : (
        <BurnOrders me={burnMe} round={burnRound} records={burnRecords} claimBurn={claimBurn} claimPersonalBurn={claimPersonalBurn} claiming={claiming} />
      )}
    </div>
  );
}

function EmptyState({ href, text }: { href: string; text: string }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-10 text-center text-sm text-white/45">
        <div>{text}</div>
        <Link href={href}><Button size="sm">去看看</Button></Link>
      </CardContent>
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/5 bg-black/30 p-2">
      <div className="text-[10px] text-white/35">{label}</div>
      <div className="mt-0.5 break-all text-xs font-semibold text-white/80">{value}</div>
    </div>
  );
}

function StakeOrders({ orders, expanded, setExpanded, claimStake, claiming }: {
  orders: StakeOrder[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  claimStake: (id: string) => void;
  claiming: string | null;
}) {
  const serverNow = useServerTime();
  if (orders.length === 0) return <EmptyState href="/stake" text="还没有质押订单" />;
  return (
    <div className="space-y-2">
      {orders.map((order) => {
        const principal = weiToNumber(order.amount);
        const matured = serverNow != null && serverNow >= order.matures_at;
        const expectedAsset = (principal * order.monthly_rate_bps * order.lock_months) / 10_000;
        const expectedFuel = expectedAsset * 0.05;
        const expectedNet = expectedAsset - expectedFuel;
        const open = expanded === order.id;
        return (
          <Card key={order.id} className={cn(matured && !order.claimed && "border-[#00c6ff]/40 bg-[#00c6ff]/5", order.claimed && "opacity-60")}>
            <CardContent className="py-3">
              <button type="button" onClick={() => setExpanded(open ? null : order.id)} className="flex w-full items-center justify-between gap-3 text-left">
                <div>
                  <div className="font-bold">{formatNumber(principal, 2)} {order.asset}</div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-white/45">
                    {order.claimed ? <CheckCircle className="h-3.5 w-3.5 text-green-400" /> : matured ? <Award className="h-3.5 w-3.5 text-[#00c6ff]" /> : <Clock className="h-3.5 w-3.5" />}
                    {order.claimed ? "已领取" : matured ? "可领取" : `到期 ${dateText(order.matures_at)}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-right">
                  <div>
                    <div className="text-[10px] text-white/35">返还(含本金)</div>
                    <div className="font-black text-[#b829ff]">≈ {formatNumber(principal + expectedAsset, 4)} {order.asset} 等值</div>
                  </div>
                  <ChevronDown className={cn("h-4 w-4 text-white/35 transition", open && "rotate-180")} />
                </div>
              </button>
              {open && (
                <div className="mt-3 space-y-3 border-t border-white/5 pt-3">
                  <div className="grid grid-cols-2 gap-2">
                    <DetailRow label="锁仓周期" value={`${order.lock_months} 个月`} />
                    <DetailRow label="月化收益" value={bpsToPercent(order.monthly_rate_bps)} />
                    <DetailRow label="预计到账" value={`≈ ${formatNumber(principal + expectedNet, 4)} ${order.asset} 等值 HS（含本金）`} />
                    <DetailRow label="开始时间" value={dateText(order.started_at)} />
                    <DetailRow label="到期时间" value={dateText(order.matures_at)} />
                    <DetailRow label="燃料销毁" value={`约 ${formatNumber(expectedFuel, 4)} ${order.asset} 等值 HS`} />
                    <DetailRow label="交易" value={displayTx(order.source_tx_hash)} />
                  </div>
                  {!order.claimed && matured && <Button onClick={() => claimStake(order.id)} disabled={claiming === order.id} className="w-full">{claiming === order.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "领取(含本金)"}</Button>}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function AiOrders({ orders, expanded, setExpanded, stockPrice }: {
  orders: AiOrder[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  stockPrice: number;
}) {
  if (orders.length === 0) return <EmptyState href="/ai" text="还没有套餐订单" />;
  return (
    <div className="space-y-2">
      {orders.map((order) => {
        const stock = weiToNumber(order.stock_granted);
        const locked = weiToNumber(order.locked_stock);
        const released = weiToNumber(order.released_stock);
        const open = expanded === order.id;
        return (
          <Card key={order.id}>
            <CardContent className="py-3">
              <button type="button" onClick={() => setExpanded(open ? null : order.id)} className="flex w-full items-center justify-between gap-3 text-left">
                <div>
                  <div className="font-bold">{order.tier.toUpperCase()} 套餐</div>
                  <div className="mt-1 text-[11px] text-white/45">{dateText(order.created_at)} · WTO {formatNumber(stock, 2)} 股</div>
                </div>
                <div className="flex items-center gap-2 text-right">
                  <div>
                    <div className="text-[10px] text-white/35">折合</div>
                    <div className="font-black text-[#b829ff]">${formatNumber(stock * stockPrice, 2)}</div>
                  </div>
                  <ChevronDown className={cn("h-4 w-4 text-white/35 transition", open && "rotate-180")} />
                </div>
              </button>
              {open && (
                <div className="mt-3 space-y-3 border-t border-white/5 pt-3">
                  <div className="grid grid-cols-2 gap-2">
                    <DetailRow label="投入" value={`${formatNumber(weiToNumber(order.usdt_in), 2)} USDT`} />
                    <DetailRow label="WTO 股价" value={`$${formatNumber(stockPrice, 4)}`} />
                    <DetailRow label="已释放" value={`${formatNumber(released, 2)} 股`} />
                    <DetailRow label="锁定中" value={`${formatNumber(locked, 2)} 股`} />
                    <DetailRow label="下次释放" value={order.next_unlocks_at ? dateText(order.next_unlocks_at) : "已全部释放"} />
                    <DetailRow label="交易" value={displayTx(order.source_tx_hash)} />
                  </div>
                  {order.releases.length > 0 && (
                    <div className="space-y-1.5">
                      {order.releases.map((release) => (
                        <div key={release.release_index} className="flex items-center justify-between rounded-md bg-black/30 px-2 py-1.5 text-xs">
                          <span>第 {release.release_index} 次 · {dateText(release.unlocks_at)}</span>
                          <span className={release.released_at ? "text-green-400" : "text-white/45"}>{formatNumber(weiToNumber(release.stock_amount), 2)} 股{release.released_at ? " 已释放" : " 待释放"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function LotteryOrders({ tickets, expanded, setExpanded, claimLottery, claiming }: {
  tickets: TicketOrder[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  claimLottery: (id: string) => void;
  claiming: string | null;
}) {
  if (tickets.length === 0) return <EmptyState href="/lottery" text="还没有彩票订单" />;
  return (
    <div className="space-y-2">
      {tickets.map((ticket) => {
        const prize = weiToNumber(ticket.prize_hs);
        const claimable = prize > 0 && !ticket.claimed;
        const open = expanded === ticket.id;
        const status = !ticket.drawn_at ? "待开奖" : prize > 0 ? ticket.claimed ? "已领取" : "中奖待领" : "未中奖";
        return (
          <Card key={ticket.id} className={cn(claimable && "border-[#b829ff]/40 bg-[#b829ff]/5", ticket.claimed && "opacity-60")}>
            <CardContent className="py-3">
              <button type="button" onClick={() => setExpanded(open ? null : ticket.id)} className="flex w-full items-center justify-between gap-3 text-left">
                <div>
                  <div className="font-mono text-lg font-black tracking-widest">{ticket.numbers}</div>
                  <div className="mt-1 text-[11px] text-white/45">第 {ticket.round_no} 期 · {status}</div>
                </div>
                <div className="flex items-center gap-2 text-right">
                  <div className={claimable ? "text-[#b829ff]" : "text-white/45"}>{prize > 0 ? `+${formatNumber(prize, 2)} HS` : "—"}</div>
                  <ChevronDown className={cn("h-4 w-4 text-white/35 transition", open && "rotate-180")} />
                </div>
              </button>
              {open && (
                <div className="mt-3 space-y-3 border-t border-white/5 pt-3">
                  <div className="grid grid-cols-2 gap-2">
                    <DetailRow label="支付" value={`${formatNumber(weiToNumber(ticket.paid_hs), 2)} HS`} />
                    <DetailRow label="开奖号码" value={ticket.winning_number ?? "待开奖"} />
                    <DetailRow label="命中" value={ticket.hit_digits ?? "—"} />
                    <DetailRow label="开奖时间" value={dateText(ticket.drawn_at)} />
                  </div>
                  {claimable && <Button onClick={() => claimLottery(ticket.id)} disabled={claiming === ticket.id} className="w-full">{claiming === ticket.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "领取奖金"}</Button>}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function BurnOrders({ me, round, records, claimBurn, claimPersonalBurn, claiming }: {
  me: BurnMe | null;
  round: BurnRound | null;
  records: BurnRecord[];
  claimBurn: () => void;
  claimPersonalBurn: () => void;
  claiming: string | null;
}) {
  const pending = weiToNumber(me?.top10PendingHs);
  const personalClaimable = weiToNumber(me?.personalClaimableHs);
  const breakdown = me?.pendingBreakdown;
  return (
    <div className="space-y-3">
      <Card className={pending > 0 ? "border-[#b829ff]/40 bg-[#b829ff]/5" : undefined}>
        <CardContent className="space-y-3 py-4">
          <div className="grid grid-cols-2 gap-2">
            <DetailRow label="累计燃烧" value={`${formatNumber(weiToNumber(me?.totalBurnedHs), 2)} HS`} />
            <DetailRow label="个人权益" value={me?.out || me?.personalClaimed ? "已领取，权重分红" : `${formatNumber(personalClaimable, 2)} HS`} />
            <DetailRow label="每周奖励" value={`${formatNumber(pending, 2)} HS`} />
            <DetailRow label="本周总燃烧" value={`${formatNumber(weiToNumber(round?.current.totalBurnHs), 2)} HS`} />
            <DetailRow label="Top10 周池" value={`${formatNumber(weiToNumber(round?.current.top10PoolHs), 2)} HS`} />
          </div>
          {breakdown && (
            <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
              <Mini label="Top10" value={breakdown.top10Hs} />
              <Mini label="权重" value={breakdown.weightHs} />
              <Mini label="推广" value={breakdown.promotionHs} />
              <Mini label="质押" value={breakdown.stakeHs} />
              <Mini label="AI" value={breakdown.aiHs} />
            </div>
          )}
          {personalClaimable > 0 && !me?.out && !me?.personalClaimed && (
            <Button onClick={claimPersonalBurn} disabled={claiming === "burn-personal"} variant="outline" className="w-full">
              {claiming === "burn-personal" ? <Loader2 className="h-4 w-4 animate-spin" /> : "领取个人燃烧权益"}
            </Button>
          )}
          {pending > 0 && <Button onClick={claimBurn} disabled={claiming === "burn"} className="w-full">{claiming === "burn" ? <Loader2 className="h-4 w-4 animate-spin" /> : "领取燃烧奖励"}</Button>}
        </CardContent>
      </Card>
      {records.length === 0 ? <EmptyState href="/burn" text="还没有燃烧记录" /> : records.map((record) => (
        <Card key={record.id}>
          <CardContent className="flex items-center justify-between py-3 text-sm">
            <div>
              <div className="font-bold">{formatNumber(weiToNumber(record.hs_amount), 2)} HS</div>
              <div className="mt-0.5 text-[11px] text-white/45">{dateText(record.burned_at)} · {record.settled_round ? `已结算 #${record.settled_round}` : "待周结算"}</div>
            </div>
            <span className="font-mono text-xs text-white/35">{displayTx(record.source_tx_hash)}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/5 bg-black/30 p-2">
      <div className="text-[10px] text-white/35">{label}</div>
      <div className="mt-0.5 font-bold text-[#b829ff]">{formatNumber(weiToNumber(value), 2)}</div>
    </div>
  );
}
