import { http, createConfig, type Config } from "wagmi";
import { defineChain, type Chain } from "viem";
import { injected } from "wagmi/connectors";
import type { RuntimeConfig } from "./runtime-config";

export function buildChain(rc: RuntimeConfig): Chain {
  return defineChain({
    id: rc.chainId,
    name: rc.chainName,
    nativeCurrency: { ...rc.nativeCurrency },
    rpcUrls: { default: { http: [rc.rpcUrl] } },
    blockExplorers: rc.blockExplorerUrl
      ? { default: { name: rc.chainName, url: rc.blockExplorerUrl } }
      : undefined,
  });
}

export function buildWagmiConfig(rc: RuntimeConfig): Config {
  const chain = buildChain(rc);
  return createConfig({
    chains: [chain],
    connectors: [injected()],
    transports: { [chain.id]: http(rc.rpcUrl) },
    ssr: true,
  });
}
