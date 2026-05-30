"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { Wallet, Pause, Play, RefreshCw, AlertTriangle, ChevronLeft, Coins, Loader2 } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { ERC20_ABI, VAULT_ABI } from "@/lib/contracts/abis";
import { useContracts } from "@/lib/runtime-config";
import { formatNumber, shortenAddress } from "@/lib/utils";

interface PendingRow {
  token: string;
  pending: number | string;
}

export default function AdminFundsPage() {
  const { isConnected, address } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState<PendingRow[]>([]);

  // LP 分红配置
  const [lpAmount, setLpAmount] = useState("100000");
  const [lpIntervalN, setLpIntervalN] = useState("1");
  const [lpIntervalUnit, setLpIntervalUnit] = useState<"day"|"week"|"month">("week");
  const [lpNextAt, setLpNextAt] = useState(0);
  const [lpLastAt, setLpLastAt] = useState(0);
  const [lpRound, setLpRound] = useState(0);
  const [lpSaving, setLpSaving] = useState(false);
  const [lpTriggering, setLpTriggering] = useState(false);
  const { vault, hsToken, usdtToken, pancakePair } = useContracts();

  const vaultDeployed = vault !== "0x0000000000000000000000000000000000000000";

  const { data: vaultUsdt } = useReadContract({
    abi: ERC20_ABI,
    address: usdtToken,
    functionName: "balanceOf",
    args: vaultDeployed ? [vault] : undefined,
    query: { enabled: vaultDeployed },
  });
  const { data: vaultHs } = useReadContract({
    abi: ERC20_ABI,
    address: hsToken,
    functionName: "balanceOf",
    args: vaultDeployed ? [vault] : undefined,
    query: { enabled: vaultDeployed },
  });
  const { data: vaultLp } = useReadContract({
    abi: ERC20_ABI,
    address: pancakePair,
    functionName: "balanceOf",
    args: vaultDeployed ? [vault] : undefined,
    query: { enabled: vaultDeployed },
  });
  const { data: pausedFlag } = useReadContract({
    abi: VAULT_ABI,
    address: vault,
    functionName: "paused",
    query: { enabled: vaultDeployed, refetchInterval: 30_000 },
  });
  const { data: signerAddr } = useReadContract({
    abi: VAULT_ABI,
    address: vault,
    functionName: "signer",
    query: { enabled: vaultDeployed, refetchInterval: 30_000 },
  });

  const fetchPending = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    try {
      const r = await api.get<{ pending: PendingRow[] }>("/admin/funds", token);
      setPending(r.pending ?? []);
    } catch { /* ignore */ }
  }, [jwt, signIn]);

  useEffect(() => {
    if (isConnected) void fetchPending();
  }, [fetchPending, isConnected]);

  const fetchLpConfig = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    try {
      const r = await api.get<{ amountHs: string; intervalSeconds: number; lastAt: number; round: number; nextAt: number }>(endpoints.adminLpDividend, token);
      setLpAmount(r.amountHs);
      setLpRound(r.round);
      setLpLastAt(r.lastAt);
      setLpNextAt(r.nextAt);
      // 从 intervalSeconds 推回 N + unit
      const sec = r.intervalSeconds;
      if (sec % (30*86400) === 0) { setLpIntervalN(String(sec / (30*86400))); setLpIntervalUnit("month"); }
      else if (sec % 604800 === 0) { setLpIntervalN(String(sec / 604800)); setLpIntervalUnit("week"); }
      else { setLpIntervalN(String(sec / 86400)); setLpIntervalUnit("day"); }
    } catch { /* ignore */ }
  }, [jwt, signIn]);

  useEffect(() => {
    if (isConnected) void fetchLpConfig();
  }, [fetchLpConfig, isConnected]);

  const saveLpConfig = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    setLpSaving(true);
    const n = Number(lpIntervalN);
    if (!Number.isFinite(n) || n <= 0) { setLpSaving(false); return; }
    let intervalSec = n * 86400;
    if (lpIntervalUnit === "week") intervalSec = n * 604800;
    else if (lpIntervalUnit === "month") intervalSec = n * 30 * 86400;
    try {
      await api.post(endpoints.adminLpDividend, {
        amountHs: Number(lpAmount),
        intervalSeconds: intervalSec,
      }, token);
      await fetchLpConfig();
    } catch { /* ignore */ } finally { setLpSaving(false); }
  };

  const triggerLpDividend = async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    const c = await Swal.fire({
      icon: "question",
      title: "确认立即分发？",
      html: "将立即计算当前 LP 分红并写入待领取记录，确定吗？",
      showCancelButton: true,
      confirmButtonColor: "#f59e0b",
      cancelButtonColor: "#374151",
      background: "#141419",
      color: "#fff",
      didOpen: () => {
        const btn = Swal.getConfirmButton();
        if (!btn) return;
        btn.disabled = true;
        let sec = 3;
        btn.textContent = `确认 (${sec}s)`;
        const timer = setInterval(() => { sec--; if (sec <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = "确认"; } else { btn.textContent = `确认 (${sec}s)`; } }, 1000);
      },
    });
    if (!c.isConfirmed) return;
    setLpTriggering(true);
    try {
      const r = await api.post<{ round: number; amountHs: string; recipients: number; skipped: boolean }>(endpoints.adminLpDividendTrigger, {}, token);
      await Swal.fire({ icon: "success", title: "分发完成", html: `轮次 ${r.round}，${Number(BigInt(r.amountHs))/1e18} HS，${r.recipients} 个接收人`, background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
      await fetchLpConfig();
    } catch (e) {
      await Swal.fire({ icon: "error", title: "分发失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    } finally { setLpTriggering(false); }
  };

  const togglePause = async (target: boolean) => {
    if (!isConnected || !address) return;
    const c = await Swal.fire({
      icon: "warning",
      title: target ? "确认暂停？" : "确认恢复？",
      text: target ? "暂停后用户将无法存款、提取、燃烧和闪兑" : "恢复后用户可正常操作",
      showCancelButton: true,
      confirmButtonColor: "#b829ff",
      background: "#141419",
      color: "#fff",
    });
    if (!c.isConfirmed) return;
    try {
      await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "setPaused",
        args: [target],
      });
      await Swal.fire({ icon: "success", title: "交易已发送", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "操作失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  const setSigner = async () => {
    const r = await Swal.fire({
      title: "切换签名地址",
      text: "输入新的 Worker 签名钱包地址",
      input: "text",
      inputPlaceholder: "0x...",
      inputAttributes: { autocapitalize: "off" },
      showCancelButton: true,
      confirmButtonColor: "#b829ff",
      background: "#141419",
      color: "#fff",
      preConfirm: (v) => {
        if (!/^0x[a-fA-F0-9]{40}$/.test(v as string)) {
          Swal.showValidationMessage("地址格式错误");
        }
        return v;
      },
    });
    if (!r.isConfirmed) return;
    try {
      await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "setSigner",
        args: [r.value as `0x${string}`],
      });
      await Swal.fire({ icon: "success", title: "已切换", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "操作失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  const withdraw = async (token: `0x${string}`, label: string) => {
    const r = await Swal.fire({
      title: `提取 ${label}`,
      html: `
        <input id="to" class="swal2-input" placeholder="目标地址 0x..." value="${address ?? ""}" />
        <input id="amt" class="swal2-input" placeholder="数量" type="number" />
      `,
      showCancelButton: true,
      confirmButtonColor: "#b829ff",
      background: "#141419",
      color: "#fff",
      preConfirm: () => {
        const to = (document.getElementById("to") as HTMLInputElement).value;
        const amt = (document.getElementById("amt") as HTMLInputElement).value;
        if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
          Swal.showValidationMessage("地址格式错误");
          return null;
        }
        const n = Number(amt);
        if (!Number.isFinite(n) || n <= 0) {
          Swal.showValidationMessage("请输入有效数量");
          return null;
        }
        return { to, amt };
      },
    });
    if (!r.isConfirmed || !r.value) return;
    try {
      const amountWei = parseUnits(String(r.value.amt), 18);
      await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: "withdrawTo",
        args: [token, r.value.to as `0x${string}`, amountWei],
      });
      await Swal.fire({ icon: "success", title: "交易已发送", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "操作失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  const usdtNum = vaultUsdt ? Number(formatUnits(vaultUsdt as bigint, 18)) : 0;
  const hsNum = vaultHs ? Number(formatUnits(vaultHs as bigint, 18)) : 0;
  const lpNum = vaultLp ? Number(formatUnits(vaultLp as bigint, 18)) : 0;

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition-colors">
          <ChevronLeft className="h-4 w-4" /> 返回管理后台
        </Link>
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Wallet className="h-6 w-6 text-[#00c6ff]" /> 资金与安全
        </h1>
        <p className="mt-1 text-sm text-white/50">
          管理 Vault 合约状态，包括暂停交易、切换签名地址、紧急提取资金
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Vault 余额</CardTitle>
              <div className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
                <p className="text-xs font-bold text-yellow-400 flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" /> DApp 合约地址
                </p>
                <p className="mt-1 font-mono text-sm text-white/80 break-all select-all">
                  {vaultDeployed ? vault : "合约未部署"}
                </p>
                <p className="mt-1 text-[11px] text-yellow-400/70">
                  请向此地址转入 HS 代币以补充 Vault 资金池，用于支付用户质押赎回等支出。
                </p>
                {vaultDeployed && (
                  <button
                    type="button"
                    className="mt-2 text-[11px] text-[#00c6ff] hover:underline"
                    onClick={() => { void navigator.clipboard.writeText(vault); }}
                  >
                    复制地址
                  </button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <BalanceRow label="USDT" value={formatNumber(usdtNum, 2)} action={() => withdraw(usdtToken, "USDT")} />
              <BalanceRow label="HS" value={formatNumber(hsNum, 2)} action={() => withdraw(hsToken, "HS")} />
              <BalanceRow label="LP" value={formatNumber(lpNum, 4)} action={() => withdraw(pancakePair, "LP")} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>合约状态</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 p-4">
                <div>
                  <div className="text-xs text-white/50">运行状态</div>
                  <div className={`mt-1 text-base font-bold ${pausedFlag ? "text-red-400" : "text-green-400"}`}>
                    {pausedFlag ? "已暂停" : "运行中"}
                  </div>
                </div>
                <div className="flex gap-2">
                  {!pausedFlag && (
                    <Button variant="danger" onClick={() => togglePause(true)}>
                      <Pause className="h-4 w-4" /> 暂停
                    </Button>
                  )}
                  {!!pausedFlag && (
                    <Button onClick={() => togglePause(false)}>
                      <Play className="h-4 w-4" /> 恢复
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 p-4">
                <div>
                  <div className="text-xs text-white/50">签名地址</div>
                  <div className="mt-1 font-mono text-sm">
                    {signerAddr ? shortenAddress(signerAddr as string, 6) : "—"}
                  </div>
                </div>
                <Button variant="outline" onClick={setSigner}>
                  <RefreshCw className="h-4 w-4" /> 切换
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* LP 交易分红 */}
          <Card className="border-[#f59e0b]/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Coins className="h-5 w-5 text-[#f59e0b]" /> LP 交易分红
              </CardTitle>
              <p className="text-xs text-white/40">HS 交易买卖滑点产生的 LP 分红，按 70%/30% 分给所有燃烧者和 Top10。</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 每期数量 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/50 shrink-0">每期</span>
                <input
                  type="number"
                  value={lpAmount}
                  onChange={(e) => setLpAmount(e.target.value)}
                  className="h-8 w-28 rounded-md border border-white/10 bg-black/40 px-2 font-mono text-xs text-white"
                />
                <span className="text-xs text-white/50">HS</span>
              </div>

              {/* 间隔：N + 单位分段按钮 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/50 shrink-0">每</span>
                <input
                  type="number"
                  value={lpIntervalN}
                  onChange={(e) => setLpIntervalN(e.target.value)}
                  className="h-8 w-16 rounded-md border border-white/10 bg-black/40 px-2 font-mono text-xs text-white"
                />
                <div className="inline-flex h-8 overflow-hidden rounded-md border border-white/10 bg-black/40">
                  {(["day","week","month"] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setLpIntervalUnit(u)}
                      className={`h-full px-3 text-xs font-medium transition-colors ${
                        lpIntervalUnit === u ? "bg-[#f59e0b]/20 text-[#f59e0b]" : "text-white/50 hover:text-white/80"
                      } ${u !== "month" ? "border-r border-white/10" : ""}`}
                    >
                      {u === "day" ? "天" : u === "week" ? "周" : "月"}
                    </button>
                  ))}
                </div>
              </div>

              {/* 分发信息 */}
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/5 bg-black/40 p-3">
                <div>
                  <div className="text-[10px] text-white/40">下次分发</div>
                  <div className="text-xs font-mono text-white">
                    {lpLastAt ? new Date(lpNextAt * 1000).toLocaleString("zh-CN") : "点击「立即分发」开始"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-white/40">上次分发</div>
                  <div className="text-xs font-mono text-white">
                    {lpLastAt ? new Date(lpLastAt * 1000).toLocaleString("zh-CN") : "从未"}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-[10px] text-white/40">已分发轮次</div>
                  <div className="text-xs font-mono text-white">{lpRound}</div>
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" disabled={lpSaving} onClick={() => { void saveLpConfig(); }}>
                  {lpSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "保存配置"}
                </Button>
                <Button variant="outline" size="sm" className="flex-1 border-[#f59e0b]/50 text-[#f59e0b]" disabled={lpTriggering} onClick={() => { void triggerLpDividend(); }}>
                  {lpTriggering ? <Loader2 className="h-3 w-3 animate-spin" /> : "立即分发"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-400" /> 待领取签名
            </CardTitle>
            <p className="text-xs text-white/40">已签发但用户尚未领取的金额汇总</p>
          </CardHeader>
          <CardContent>
            {pending.length === 0 ? (
              <div className="py-6 text-center text-sm text-white/40">暂无待领取签名</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase text-white/40">
                    <th className="px-3 py-3">代币</th>
                    <th className="px-3 py-3 text-right">待领取总额</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((p) => (
                    <tr key={p.token} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-3 py-3 font-mono text-xs">{shortenAddress(p.token, 6)}</td>
                      <td className="px-3 py-3 text-right font-bold">
                        {formatNumber(Number(BigInt(String(p.pending))) / 1e18, 4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}

function BalanceRow({ label, value, action }: { label: string; value: string; action: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/30 p-4">
      <div>
        <div className="text-xs text-white/50">{label}</div>
        <div className="mt-1 text-2xl font-black">{value}</div>
      </div>
      <Button variant="outline" onClick={action}>
        提取
      </Button>
    </div>
  );
}
