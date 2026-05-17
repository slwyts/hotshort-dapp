"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { Loader2, Link2 } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { api, endpoints } from "@/lib/api";
import { getStoredReferrer } from "@/components/referral-handler";

interface MeResp {
  referrer: string | null;
}

export function ReferrerBindCard({ onBound }: { onBound?: () => void }) {
  const { address, isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const [referrer, setReferrer] = useState<string | null | undefined>(undefined);
  const [refInput, setRefInput] = useState("");
  const [binding, setBinding] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    const token = jwt ?? (await signIn());
    if (!token) return;
    const m = await api.get<MeResp>("/referral/me", token).catch(() => null);
    setReferrer(m?.referrer ?? null);
  }, [isConnected, jwt, signIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (referrer === null && !refInput) {
      const stored = getStoredReferrer();
      if (stored) setRefInput(stored);
    }
  }, [referrer, refInput]);

  if (!isConnected) return null;
  if (referrer === undefined) return null;
  if (referrer) return null;

  const bind = async () => {
    const ref = refInput.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(ref)) {
      await Swal.fire({ icon: "error", title: t("me.team.bindInvalid"), background: "#141419", color: "#fff" });
      return;
    }
    if (address && ref === address.toLowerCase()) {
      await Swal.fire({ icon: "error", title: t("me.team.bindSelf"), background: "#141419", color: "#fff" });
      return;
    }
    const token = jwt ?? (await signIn());
    if (!token) return;
    setBinding(true);
    try {
      await api.post(endpoints.referralBind, { referrer: ref }, token);
      await Swal.fire({
        icon: "success",
        title: t("me.team.bindSuccess"),
        background: "#141419",
        color: "#fff",
        confirmButtonColor: "#b829ff",
        timer: 1500,
      });
      setRefInput("");
      await refresh();
      onBound?.();
    } catch (e) {
      await Swal.fire({
        icon: "error",
        title: t("me.team.bindFailed"),
        text: (e as Error).message,
        background: "#141419",
        color: "#fff",
      });
    } finally {
      setBinding(false);
    }
  };

  return (
    <Card className="border-[#b829ff]/30 bg-[#b829ff]/5">
      <CardContent className="py-4">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-[#b829ff]">
          <Link2 className="h-3 w-3" />
          {t("me.team.bindTitle")}
        </div>
        <p className="mb-3 text-[11px] text-white/50">{t("me.team.bindHint")}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={refInput}
            onChange={(e) => setRefInput(e.target.value)}
            placeholder="0x..."
            spellCheck={false}
            className="flex-1 rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white outline-none focus:border-[#b829ff]"
          />
          <Button onClick={bind} disabled={binding || !refInput.trim()} size="sm">
            {binding ? <Loader2 className="h-4 w-4 animate-spin" /> : t("me.team.bindAction")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
