"use client";

import { useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { ERC20_ABI } from "@/lib/contracts/abis";

/**
 * 解决 TP / Bitget 等钱包对 "approve + 业务tx" 串行流程的兼容问题：
 *   - TP 在 approve 广播后立刻 resolve，第二笔会复用旧 nonce 被节点拒绝
 *   - Bitget 不允许前一笔 pending 时再弹第二笔签名
 * 流程：
 *   1) 先读链上 allowance，足额则直接返回（连 approve 都跳过）
 *   2) 不够则 approve，等到 receipt 上链后再让调用方发业务 tx
 */
export function useEnsureAllowance() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  return useCallback(
    async (params: {
      token: `0x${string}`;
      spender: `0x${string}`;
      amount: bigint;
    }): Promise<void> => {
      if (!address) throw new Error("wallet not connected");
      if (!publicClient) throw new Error("public client unavailable");

      const current = (await publicClient.readContract({
        address: params.token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, params.spender],
      })) as bigint;
      if (current >= params.amount) return;

      const hash = await writeContractAsync({
        address: params.token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [params.spender, params.amount],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    [address, publicClient, writeContractAsync],
  );
}
