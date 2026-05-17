"use client";

import { useState } from "react";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label="Change language"
      >
        <Languages className="h-4 w-4" />
      </Button>
      {open && (
        <>
          <button
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="glass-panel absolute right-0 top-12 z-20 w-32 rounded-xl border border-white/10 p-1 text-sm">
            <button
              className="flex w-full items-center justify-between rounded-md px-3 py-2 hover:bg-white/5"
              onClick={() => {
                setLocale("zh");
                setOpen(false);
              }}
            >
              中文 {locale === "zh" && <span className="text-[#b829ff]">✓</span>}
            </button>
            <button
              className="flex w-full items-center justify-between rounded-md px-3 py-2 hover:bg-white/5"
              onClick={() => {
                setLocale("en");
                setOpen(false);
              }}
            >
              English {locale === "en" && <span className="text-[#b829ff]">✓</span>}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
