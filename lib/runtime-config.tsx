"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface RuntimeConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  blockExplorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: 18 };
  contracts: {
    vault: `0x${string}`;
    hsToken: `0x${string}`;
    usdtToken: `0x${string}`;
    pancakePair: `0x${string}`;
    pancakeLottery: `0x${string}` | null;
  };
}

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export function RuntimeConfigProvider({
  value,
  children,
}: {
  value: RuntimeConfig;
  children: ReactNode;
}) {
  return (
    <RuntimeConfigContext.Provider value={value}>
      {children}
    </RuntimeConfigContext.Provider>
  );
}

export function useRuntimeConfig(): RuntimeConfig {
  const v = useContext(RuntimeConfigContext);
  if (!v) throw new Error("RuntimeConfigProvider not mounted");
  return v;
}

export function useContracts() {
  return useRuntimeConfig().contracts;
}

export function useChainInfo() {
  const { chainId, chainName, rpcUrl, blockExplorerUrl, nativeCurrency } =
    useRuntimeConfig();
  return { chainId, chainName, rpcUrl, blockExplorerUrl, nativeCurrency };
}
