"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { Wallet, Pause, Play, RefreshCw, AlertTriangle } from "lucide-react";
import Swal from "sweetalert2";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api } from "@/lib/api";
import { ERC20_ABI, VAULT_ABI } from "@/lib/contracts/abis";
import { HOTSHORT_VAULT, HS_TOKEN, USDT_TOKEN } from "@/lib/contracts/addresses";
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

  const { data: vaultUsdt } = useReadContract({
    abi: ERC20_ABI,
    address: USDT_TOKEN as `0x${string}`,
    functionName: "balanceOf",
    args: HOTSHORT_VAULT === "0x0000000000000000000000000000000000000000" ? undefined : [HOTSHORT_VAULT as `0x${string}`],
    query: { enabled: HOTSHORT_VAULT !== "0x0000000000000000000000000000000000000000" },
  });
  const { data: vaultHs } = useReadContract({
    abi: ERC20_ABI,
    address: HS_TOKEN as `0x${string}`,
    functionName: "balanceOf",
    args: HOTSHORT_VAULT === "0x0000000000000000000000000000000000000000" ? undefined : [HOTSHORT_VAULT as `0x${string}`],
    query: { enabled: HOTSHORT_VAULT !== "0x0000000000000000000000000000000000000000" },
  });
  const { data: pausedFlag } = useReadContract({
    abi: VAULT_ABI,
    address: HOTSHORT_VAULT as `0x${string}`,
    functionName: "paused",
    query: { enabled: HOTSHORT_VAULT !== "0x0000000000000000000000000000000000000000", refetchInterval: 30_000 },
  });
  const { data: signerAddr } = useReadContract({
    abi: VAULT_ABI,
    address: HOTSHORT_VAULT as `0x${string}`,
    functionName: "signer",
    query: { enabled: HOTSHORT_VAULT !== "0x0000000000000000000000000000000000000000", refetchInterval: 30_000 },
  });

  const fetchPending = useCallback(async () => {
    const token = jwt ?? (await signIn());
    if (!token) return;
    try {
      const r = await api.get<{ pending: PendingRow[] }>("/admin/funds", token);
      setPending(r.pending ?? []);
    } catch {
      /* ignore */
    }
  }, [jwt, signIn]);

  useEffect(() => {
    if (isConnected) void fetchPending();
  }, [fetchPending, isConnected]);

  const togglePause = async (target: boolean) => {
    if (!isConnected || !address) return;
    const c = await Swal.fire({
      icon: "warning",
      title: target ? "确认暂停 Vault？" : "确认恢复 Vault？",
      text: target ? "暂停后所有 deposit/claim/burn/swap 失败" : "用户操作恢复",
      showCancelButton: true,
      confirmButtonColor: "#b829ff",
      background: "#141419",
      color: "#fff",
    });
    if (!c.isConfirmed) return;
    try {
      await writeContractAsync({
        address: HOTSHORT_VAULT as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "setPaused",
        args: [target],
      });
      await Swal.fire({ icon: "success", title: "已发送交易", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  const setSigner = async () => {
    const r = await Swal.fire({
      title: "切换 signer",
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
        address: HOTSHORT_VAULT as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "setSigner",
        args: [r.value as `0x${string}`],
      });
      await Swal.fire({ icon: "success", title: "已切换", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  const withdraw = async (token: `0x${string}`, label: string) => {
    const r = await Swal.fire({
      title: `从 Vault 紧急提取 ${label}`,
      html: `
        <input id="to" class="swal2-input" placeholder="目标地址 0x..." />
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
          Swal.showValidationMessage("数量错误");
          return null;
        }
        return { to, amt };
      },
    });
    if (!r.isConfirmed || !r.value) return;
    try {
      const amountWei = parseUnits(String(r.value.amt), 18);
      await writeContractAsync({
        address: HOTSHORT_VAULT as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "withdrawTo",
        args: [token, r.value.to as `0x${string}`, amountWei],
      });
      await Swal.fire({ icon: "success", title: "已发送", background: "#141419", color: "#fff", confirmButtonColor: "#b829ff" });
    } catch (e) {
      await Swal.fire({ icon: "error", title: "失败", text: (e as Error).message, background: "#141419", color: "#fff" });
    }
  };

  const usdtNum = vaultUsdt ? Number(formatUnits(vaultUsdt as bigint, 18)) : 0;
  const hsNum = vaultHs ? Number(formatUnits(vaultHs as bigint, 18)) : 0;

  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-black flex items-center gap-2">
          <Wallet className="h-6 w-6 text-[#00c6ff]" /> 资金归集 / 应急
        </h1>
        <p className="mt-1 text-sm text-white/50">
          直接对 Vault 合约的 owner-only 调用：setSigner / setPaused / withdrawTo。
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Vault 链上余额</CardTitle>
              <CardDescription className="font-mono text-xs">
                {HOTSHORT_VAULT === "0x0000000000000000000000000000000000000000" ? "Vault 未部署" : shortenAddress(HOTSHORT_VAULT, 8)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Stat label="USDT" value={formatNumber(usdtNum, 2)} action={() => withdraw(USDT_TOKEN as `0x${string}`, "USDT")} />
              <Stat label="HS" value={formatNumber(hsNum, 2)} action={() => withdraw(HS_TOKEN as `0x${string}`, "HS")} />
              <p className="text-xs text-white/30">点右侧按钮发起 owner withdrawTo（紧急提取/补给奖池）。</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>合约状态</CardTitle>
              <CardDescription>暂停 / 切换 signer 即时生效</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                <div>
                  <div className="text-xs text-white/50">paused</div>
                  <div className={`mt-1 text-base font-bold ${pausedFlag ? "text-red-400" : "text-green-400"}`}>
                    {pausedFlag ? "PAUSED" : "RUNNING"}
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

              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                <div>
                  <div className="text-xs text-white/50">signer</div>
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
              <AlertTriangle className="h-5 w-5 text-yellow-400" /> 应付未消费签名
            </CardTitle>
            <CardDescription>已签出但未在链上 claim 的总额（提示备货）</CardDescription>
          </CardHeader>
          <CardContent>
            {pending.length === 0 ? (
              <div className="py-6 text-center text-sm text-white/40">无应付签名</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase text-white/40">
                    <th className="px-2 py-2">Token</th>
                    <th className="px-2 py-2 text-right">应付总额</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((p) => (
                    <tr key={p.token} className="border-b border-white/5">
                      <td className="px-2 py-2 font-mono text-xs">{shortenAddress(p.token, 6)}</td>
                      <td className="px-2 py-2 text-right font-bold">
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

function Stat({ label, value, action }: { label: string; value: string; action: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/40 p-3">
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
