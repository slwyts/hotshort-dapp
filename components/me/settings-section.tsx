"use client";

import { useAccount, useDisconnect } from "wagmi";
import {
  Languages,
  Globe,
  LogOut,
  Info,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";

const APP_VERSION = "0.1.0";

export function SettingsSection() {
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { locale, setLocale, t } = useLocale();

  const switchLang = () => {
    setLocale(locale === "zh" ? "en" : "zh");
  };

  const onDisconnect = () => {
    if (!isConnected) return;
    disconnect();
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="divide-y divide-white/5 py-0">
          <Row
            icon={Globe}
            iconColor="#00c6ff"
            label={t("me.settings.language")}
            value={locale === "zh" ? t("me.settings.lang.zh") : t("me.settings.lang.en")}
            onClick={switchLang}
          />
          <Row
            icon={Languages}
            iconColor="#b829ff"
            label={t("me.settings.network")}
            value={t("wallet.network")}
            disabled
          />
          {isConnected && (
            <Row
              icon={LogOut}
              iconColor="#ef4444"
              label={t("me.settings.disconnect")}
              danger
              onClick={onDisconnect}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-white/40">
              <Info className="h-3.5 w-3.5" />
              <span>{t("me.settings.about")} · {t("me.settings.version")}</span>
            </div>
            <span className="font-mono text-white/50">v{APP_VERSION}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  icon: Icon,
  iconColor,
  label,
  value,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  label: string;
  value?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const interactive = !!onClick && !disabled;
  return (
    <div
      onClick={interactive ? onClick : undefined}
      className={`flex items-center gap-3 py-3.5 ${
        interactive ? "cursor-pointer transition active:bg-white/[0.02]" : ""
      }`}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
        style={{ background: `${iconColor}20`, color: iconColor }}
      >
        <Icon className="h-4 w-4" />
      </div>
      <span className={`flex-1 text-sm font-medium ${danger ? "text-red-400" : "text-white"}`}>{label}</span>
      {value && <span className="text-xs text-white/50">{value}</span>}
      {interactive && !danger && <ChevronRight className="h-4 w-4 text-white/30" />}
    </div>
  );
}