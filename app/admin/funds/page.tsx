"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { Wallet, Pause, Play, RefreshCw, AlertTriangle, ChevronLeft } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api } from "@/lib/api";
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
              <p className="text-xs text-white/40 font-mono">
                {vaultDeployed ? shortenAddress(vault, 8) : "合约未部署"}
              </p>
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
