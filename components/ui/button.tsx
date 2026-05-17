"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const variantClasses: Record<string, string> = {
  default:
    "bg-gradient-to-r from-[#00c6ff] to-[#b829ff] text-white shadow-[0_0_24px_rgba(184,41,255,0.35)] hover:opacity-95 active:scale-[0.99]",
  outline:
    "border border-white/10 bg-white/5 text-white hover:border-[#b829ff]/50 hover:bg-[#b829ff]/5",
  ghost: "bg-transparent text-white hover:bg-white/5",
  danger:
    "border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20",
};

const sizeClasses: Record<string, string> = {
  sm: "h-8 px-3 text-xs rounded-md",
  md: "h-10 px-4 text-sm rounded-lg",
  lg: "h-12 px-6 text-base rounded-xl",
  icon: "h-10 w-10 rounded-lg",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantClasses;
  size?: keyof typeof sizeClasses;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 font-semibold tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#b829ff]/40",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
