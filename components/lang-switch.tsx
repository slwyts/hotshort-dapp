"use client";

import { Languages } from "lucide-react";
import { useLocale } from "@/components/locale-provider";

/**
 * 顶栏一键语言切换：单按钮，点一下即在 zh / en 间切换。
 * 状态由 LocaleProvider 管理并持久化到 localStorage。
 */
export function LangSwitch() {
  const { locale, toggleLocale } = useLocale();

  return (
    <button
      onClick={toggleLocale}
      aria-label="Switch language"
      className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] font-bold text-white/70 transition hover:border-[#00c6ff]/40 hover:text-white"
    >
      <Languages className="h-3.5 w-3.5" />
      <span className="tabular-nums">{locale === "zh" ? "中" : "EN"}</span>
    </button>
  );
}