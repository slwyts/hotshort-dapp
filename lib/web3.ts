import { http, createConfig } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";

const localhost = defineChain({
  id: 31337,
  name: "Localhost",
  nativeCurrency: { decimals: 18, name: "BNB", symbol: "BNB" },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const networkMode = process.env.NEXT_PUBLIC_NETWORK || "bsc";

let chains: readonly [typeof localhost] | readonly [typeof bscTestnet] | readonly [typeof bsc];
let transports: Record<number, ReturnType<typeof http>>;

if (networkMode === "localnet") {
  chains = [localhost] as const;
  transports = { [localhost.id]: http() };
} else if (networkMode === "bsc-testnet") {
  chains = [bscTestnet] as const;
  transports = { [bscTestnet.id]: http() };
} else {
  chains = [bsc] as const;
  transports = { [bsc.id]: http() };
}

export const config = createConfig({
  chains,
  connectors: [injected()],
  transports,
  ssr: true,
});

export const TARGET_CHAIN = chains[0];
