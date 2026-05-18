"use client";

import { useEffect } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { useChainInfo } from "@/lib/runtime-config";

export function NetworkSwitcher() {
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const target = useChainInfo();

  useEffect(() => {
    if (!isConnected) return;
    if (chainId && chainId !== target.chainId) {
      const timer = setTimeout(() => {
        switchChain(
          { chainId: target.chainId },
          {
            onError: async (error) => {
              const msg = error.message.toLowerCase();
              if (
                msg.includes("unrecognized chain") ||
                msg.includes("chain") ||
                msg.includes("network") ||
                error.name === "ChainNotConfiguredError"
              ) {
                await addNetwork(target);
              }
            },
          },
        );
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isConnected, chainId, target, switchChain]);

  return null;
}

async function addNetwork(target: ReturnType<typeof useChainInfo>) {
  if (typeof window === "undefined") return;
  const eth = (window as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum;
  if (!eth) return;
  const params: Record<string, unknown> = {
    chainId: `0x${target.chainId.toString(16)}`,
    chainName: target.chainName,
    nativeCurrency: target.nativeCurrency,
    rpcUrls: [target.rpcUrl],
  };
  if (target.blockExplorerUrl) {
    params.blockExplorerUrls = [target.blockExplorerUrl];
  }
  try {
    await eth.request({ method: "wallet_addEthereumChain", params: [params] });
  } catch {
    /* noop — user rejected */
  }
}
