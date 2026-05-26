"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Coins, Sparkles, Ticket, User, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocale } from "@/components/locale-provider";

interface Tab {
  href: string;
  icon: LucideIcon;
  labelKey: string;
  highlight?: boolean;
}

const tabs: Tab[] = [
  { href: "/", icon: Home, labelKey: "nav.home" },
  { href: "/stake", icon: Coins, labelKey: "nav.stake" },
  { href: "/ai", icon: Sparkles, labelKey: "nav.ai", highlight: true },
  { href: "/lottery", icon: Ticket, labelKey: "nav.lottery" },
  { href: "/me", icon: User, labelKey: "nav.me" },
];

/**
 * 5-tab 移动端底部导航。
 *   - admin 路由不显示
 *   - 当前 tab 上浮 + 高亮
 *   - 中间 AI tab 突出（科技感锚点，承担"主推位"）
 */
export function BottomNav() {
  const pathname = usePathname();
  const { t } = useLocale();
  if (pathname.startsWith("/admin")) return null;

  return (
    <nav
      aria-label="主导航"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/5 backdrop-blur-xl"
      style={{
        background: "var(--hs-bottom-nav-bg)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div className="mx-auto flex h-16 w-full max-w-md items-center justify-between px-2">
        {tabs.map((tab) => {
          const active =
            tab.href === "/"
              ? pathname === "/"
              : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex h-full flex-1 flex-col items-center justify-center gap-0.5 transition-all",
                active && "-translate-y-0.5",
              )}
            >
              <div
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-xl transition-all",
                  active
                    ? tab.highlight
                      ? "bg-gradient-to-br from-[#00c6ff] to-[#b829ff] shadow-[0_8px_24px_rgba(184,41,255,0.4)]"
                      : "bg-white/10"
                    : "bg-transparent",
                )}
              >
                <Icon
                  className={cn(
                    "h-5 w-5 transition-colors",
                    active ? "text-white" : "text-white/40",
                  )}
                />
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium tracking-wide transition-colors",
                  active ? "text-white" : "text-white/40",
                )}
              >
                {t(tab.labelKey)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
