"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isLight = mounted && resolvedTheme === "light";

  return (
    <button
      type="button"
      aria-label={isLight ? "切换夜间模式" : "切换白天模式"}
      title={isLight ? "切换夜间模式" : "切换白天模式"}
      onClick={() => setTheme(isLight ? "dark" : "light")}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/70 transition hover:border-[#00c6ff]/45 hover:bg-[#00c6ff]/10 hover:text-white"
    >
      {isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}