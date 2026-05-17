"use client";

import { useEffect } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { config } from "@/lib/web3";

export function NetworkSwitcher() {
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  useEffect(() => {
    if (!isConnected) return;
    const targetChain = config.chains[0];
    if (chainId && chainId !== targetChain.id) {
      const timer = setTimeout(() => {
        switchChain(
          { chainId: targetChain.id },
          {
            onError: async (error) => {
              const msg = error.message.toLowerCase();
              if (
                msg.includes("unrecognized chain") ||
                msg.includes("chain") ||
                msg.includes("network") ||
                error.name === "ChainNotConfiguredError"
              ) {
                await addNetwork(targetChain);
              }
            },
          },
        );
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isConnected, chainId, switchChain]);

  return null;
}

async function addNetwork(chain: typeof config.chains[number]) {
  if (typeof window === "undefined") return;
  const eth = (window as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum;
  if (!eth) return;
  const params: Record<string, unknown> = {
    chainId: `0x${chain.id.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [chain.rpcUrls.default.http[0]],
  };
  if (chain.blockExplorers?.default?.url) {
    params.blockExplorerUrls = [chain.blockExplorers.default.url];
  }
  try {
    await eth.request({ method: "wallet_addEthereumChain", params: [params] });
  } catch {
    /* noop — user rejected */
  }
}
