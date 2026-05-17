"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { Copy, Share2, QrCode } from "lucide-react";
import Swal from "sweetalert2";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";

export function InviteSection() {
  const { address, isConnected } = useAccount();
  const { t } = useLocale();
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  if (!isConnected || !address) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-white/50">{t("common.connectFirst")}</CardContent>
      </Card>
    );
  }

  const link = `${origin}/?ref=${address}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=050505&color=ffffff&margin=8&data=${encodeURIComponent(link)}`;

  const copy = async (text: string, msg: string) => {
    await navigator.clipboard.writeText(text);
    Swal.fire({
      icon: "success",
      title: msg,
      timer: 1200,
      showConfirmButton: false,
      background: "#141419",
      color: "#fff",
    });
  };

  const share = async () => {
    if (typeof navigator !== "undefined" && (navigator as Navigator & { share?: (data: { title: string; url: string }) => Promise<void> }).share) {
      try {
        await (navigator as Navigator & { share: (data: { title: string; url: string }) => Promise<void> }).share({
          title: "Hotshort",
          url: link,
        });
      } catch {
        /* user cancelled */
      }
    } else {
      await copy(link, t("me.invite.copied"));
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-col items-center py-6">
          <div className="rounded-2xl border border-white/10 bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrUrl} alt="invite qrcode" width={200} height={200} className="h-44 w-44" />
          </div>
          <div className="mt-4 text-center">
            <div className="flex items-center justify-center gap-2 text-xs text-white/40">
              <QrCode className="h-3 w-3" /> {t("me.invite.qrHint")}
            </div>
            <div className="mt-1 font-mono text-[11px] text-white/50">
              ref = {address.slice(0, 8)}...{address.slice(-6)}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-white/40">{t("me.invite.linkLabel")}</div>
            <div className="break-all rounded-lg border border-white/5 bg-black/40 p-2.5 font-mono text-[11px] text-white/70">
              {link}
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => copy(link, t("me.invite.copied"))} className="flex-1">
              <Copy className="h-4 w-4" /> {t("me.invite.copyLink")}
            </Button>
            <Button onClick={share} variant="outline" className="flex-1">
              <Share2 className="h-4 w-4" /> {t("me.invite.share")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-white/40">{t("me.invite.rulesTitle")}</div>
          <ul className="space-y-1.5 text-xs text-white/60">
            <li>• {t("me.invite.rule1")}</li>
            <li>• {t("me.invite.rule2")}</li>
            <li>• {t("me.invite.rule3")}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
