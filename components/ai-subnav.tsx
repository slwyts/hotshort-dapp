"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/ai", labelKey: "ai.subnav.plans" },
  { href: "/ai/dividend", labelKey: "ai.subnav.dividend" },
  { href: "/ai/swap", labelKey: "ai.subnav.swap" },
  { href: "/ai/sell", labelKey: "ai.subnav.sell" },
];

export function AiSubnav() {
  const pathname = usePathname();
  const { t } = useLocale();
  return (
    <div className="mb-4 flex gap-1 rounded-xl border border-white/5 bg-black/40 p-1">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex-1 rounded-lg py-2 text-center text-sm font-medium transition",
              active
                ? "bg-gradient-to-r from-[#00c6ff]/20 to-[#b829ff]/20 text-white shadow-[inset_0_0_0_1px_rgba(184,41,255,0.4)]"
                : "text-white/50 hover:text-white",
            )}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </div>
  );
}
