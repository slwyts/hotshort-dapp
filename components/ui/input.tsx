import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white placeholder:text-white/30",
        "focus:outline-none focus:ring-2 focus:ring-[#b829ff]/40 focus:border-[#b829ff]/60",
        "disabled:opacity-50 disabled:cursor-not-allowed transition",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
