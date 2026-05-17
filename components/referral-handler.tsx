"use client";

import { useEffect } from "react";

const REFERRAL_KEY = "hotshort_referrer";

/**
 * 处理 ?ref=0x... 邀请链接：
 *   - URL 带 ref 参数 → 写入 localStorage 持久化
 *   - 后续连接钱包 / 下单时由各模块读取并传给 Worker /referral/bind
 */
export function ReferralHandler() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (!ref) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(ref)) return;
    const existing = localStorage.getItem(REFERRAL_KEY);
    if (existing && existing.toLowerCase() === ref.toLowerCase()) return;
    if (!existing) {
      localStorage.setItem(REFERRAL_KEY, ref.toLowerCase());
    }
  }, []);
  return null;
}

export function getStoredReferrer(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFERRAL_KEY);
}
