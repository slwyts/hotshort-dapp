"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import Swal from "sweetalert2";
import { useAccount } from "wagmi";
import { api, endpoints } from "@/lib/api";
import { useSiweJwt } from "@/lib/hooks/use-siwe";
import { useLocale } from "@/components/locale-provider";

interface MeResp {
  referrer: string | null;
}

/**
 * 下单 / 燃烧 / 抽奖等动作前调用 ensureBound() 校验：
 *   - 已连接 + 已绑定上级 → 返回 true
 *   - 未连接 → false（调用方负责提示连接钱包）
 *   - 已连接但未绑定 → 弹 1s 悬浮提示后跳转 /me?tab=invite，返回 false
 */
export function useReferralGate() {
  const { isConnected } = useAccount();
  const { jwt, signIn } = useSiweJwt();
  const { t } = useLocale();
  const router = useRouter();

  const ensureBound = useCallback(async (): Promise<boolean> => {
    if (!isConnected) return false;
    const token = jwt ?? (await signIn());
    if (!token) return false;
    const me = await api.get<MeResp>(endpoints.referralMe, token).catch(() => null);
    if (me?.referrer) return true;

    void Swal.fire({
      icon: "info",
      title: t("me.team.needUpline"),
      background: "#141419",
      color: "#fff",
      timer: 1000,
      showConfirmButton: false,
      toast: true,
      position: "top",
    });
    setTimeout(() => router.push("/me?tab=invite"), 1000);
    return false;
  }, [isConnected, jwt, signIn, t, router]);

  return { ensureBound };
}
