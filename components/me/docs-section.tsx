"use client";

import { BookOpen, ClipboardList, Coins, Flame, Sparkles, Ticket, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";

const MODULES = [
  { key: "stake", icon: Coins, color: "#00c6ff" },
  { key: "ai", icon: Sparkles, color: "#b829ff" },
  { key: "lottery", icon: Ticket, color: "#f59e0b" },
  { key: "burn", icon: Flame, color: "#ef4444" },
  { key: "invite", icon: Users, color: "#22c55e" },
] as const;

const START_STEPS = ["connect", "bind", "choose", "track"] as const;
const ORDER_POINTS = ["assets", "orders", "claims"] as const;

export function DocsSection() {
  const { t } = useLocale();

  return (
    <div className="space-y-3">
      <Card className="border-[#00c6ff]/15 bg-[#00c6ff]/5">
        <CardContent className="py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#00c6ff]/15 text-[#00c6ff]">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-white">{t("me.docs.title")}</h2>
              <p className="mt-1 text-sm leading-6 text-white/60">{t("me.docs.subtitle")}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ClipboardList className="h-4 w-4 text-[#00c6ff]" /> {t("me.docs.start.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 py-3 pt-0">
          {START_STEPS.map((step, index) => (
            <div key={step} className="flex gap-3 rounded-lg border border-white/5 bg-black/25 p-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-black text-white/80">
                {index + 1}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-white">{t(`me.docs.start.${step}.title`)}</div>
                <div className="mt-0.5 text-xs leading-5 text-white/50">{t(`me.docs.start.${step}.body`)}</div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {MODULES.map(({ key, icon: Icon, color }) => (
          <Card key={key}>
            <CardContent className="py-4">
              <div className="flex gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${color}22`, color }}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-black text-white">{t(`me.docs.module.${key}.title`)}</div>
                  <div className="text-xs leading-5 text-white/55">{t(`me.docs.module.${key}.body`)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("me.docs.order.title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 py-3 pt-0">
          {ORDER_POINTS.map((point) => (
            <div key={point} className="rounded-lg border border-white/5 bg-black/25 p-3">
              <div className="text-xs font-bold text-white">{t(`me.docs.order.${point}.title`)}</div>
              <div className="mt-1 text-xs leading-5 text-white/50">{t(`me.docs.order.${point}.body`)}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}