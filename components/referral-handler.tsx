"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const REFERRAL_KEY = "hotshort_referrer";

/**
 * 处理 ?ref=邀请码 邀请链接：
 *   - URL 带 ref → 存 localStorage
 *   - 不在 /me 时自动跳 /me?tab=assets，绑定卡会读 storage 预填
 *   - 跳转后清掉 URL 上的 ?ref，避免分享 / 收藏夹重复触发
 *   - 已绑定 / 自己 = ref 等情况由 /referral/bind 接口最终把关
 */
export function ReferralHandler() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ref = searchParams.get("ref");
    if (!ref || !(/^[A-Za-z0-9]{4,12}$/.test(ref) || /^0x[a-fA-F0-9]{40}$/.test(ref))) return;

    const normalized = ref.startsWith("0x") ? ref.toLowerCase() : ref.toUpperCase();
    localStorage.setItem(REFERRAL_KEY, normalized);

    // 清掉 URL 的 ?ref，保留其它 query
    const params = new URLSearchParams(searchParams.toString());
    params.delete("ref");
    const queryStr = params.toString();
    const cleanUrl = queryStr ? `${pathname}?${queryStr}` : pathname;

    if (pathname === "/me") {
      router.replace(cleanUrl);
    } else {
      router.replace("/me?tab=assets");
    }
  }, [pathname, router, searchParams]);

  return null;
}

export function getStoredReferrer(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFERRAL_KEY);
}

export function clearStoredReferrer(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(REFERRAL_KEY);
}
