"use client";

import { useMemo, type ReactNode } from "react";
import { State, WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildWagmiConfig } from "@/lib/web3";
import { RuntimeConfigProvider, type RuntimeConfig } from "@/lib/runtime-config";
import { NetworkSwitcher } from "./network-switcher";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 5_000,
    },
  },
});

export function Web3Provider({
  children,
  initialConfig,
  initialState,
}: {
  children: ReactNode;
  initialConfig: RuntimeConfig;
  initialState?: State;
}) {
  const wagmiConfig = useMemo(() => buildWagmiConfig(initialConfig), [initialConfig]);

  return (
    <RuntimeConfigProvider value={initialConfig}>
      <WagmiProvider config={wagmiConfig} initialState={initialState}>
        <QueryClientProvider client={queryClient}>
          <NetworkSwitcher />
          {children}
        </QueryClientProvider>
      </WagmiProvider>
    </RuntimeConfigProvider>
  );
}
