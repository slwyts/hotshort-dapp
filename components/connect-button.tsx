"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shortenAddress } from "@/lib/utils";
import { useLocale } from "@/components/locale-provider";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { t } = useLocale();

  if (isConnected && address) {
    return (
      <Button variant="outline" size="sm" onClick={() => disconnect()} className="gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
        <span className="font-mono text-xs">{shortenAddress(address, 3)}</span>
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      disabled={isPending}
      onClick={() => {
        const c = connectors[0];
        if (c) connect({ connector: c });
      }}
    >
      <Wallet className="h-3.5 w-3.5" />
      {isPending ? "..." : t("wallet.connect")}
    </Button>
  );
}
