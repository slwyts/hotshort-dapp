"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./connect-button";
import { LangSwitch } from "./lang-switch";
import { useLocale } from "./locale-provider";

/**
 * 移动端 sticky header：左 logo + 品牌 + 右语言切换 + 连接钱包。
 * 价格条已移到首页仪表盘行情卡，不在此显示。
 */
export function SiteHeader() {
  const { t } = useLocale();
  const pathname = usePathname();
  const isAdmin = pathname.startsWith("/admin");

  return (
    <header
      className="sticky top-0 z-30 border-b border-white/5 backdrop-blur-xl"
      style={{ background: "rgba(10, 10, 12, 0.75)" }}
    >
      <div className="mx-auto flex h-14 w-full max-w-md items-center justify-between gap-2 px-4">
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-[#b829ff]/40 shadow-[0_0_12px_rgba(184,41,255,0.3)]">
            <Image src="/mascots/logo.png" alt="HOTSHORT" width={32} height={32} />
          </div>
          <span
            className="truncate text-base font-black uppercase tracking-widest"
            style={{ fontFamily: "Orbitron, sans-serif" }}
          >
            HOT<span className="neon-text">SHORT</span>
          </span>
          {isAdmin && (
            <span className="ml-1 rounded border border-[#b829ff]/40 bg-[#b829ff]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#b829ff]">
              {t("site.adminBadge")}
            </span>
          )}
        </Link>

        <div className="flex shrink-0 items-center gap-1.5">
          <LangSwitch />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
