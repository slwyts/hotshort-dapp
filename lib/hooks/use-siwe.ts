"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { api, endpoints, ApiError } from "@/lib/api";

const STORAGE_PREFIX = "hotshort_jwt_";

/**
 * SIWE 登录 hook：管理 JWT 的获取与缓存。
 * 用法：
 *   const { jwt, signIn, signOut } = useSiweJwt();
 *   const token = jwt ?? (await signIn());
 *   if (!token) return;
 *   await api.get('/stake/orders', token);
 */
export function useSiweJwt() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [jwt, setJwt] = useState<string | null>(null);

  const storageKey = address ? `${STORAGE_PREFIX}${address.toLowerCase()}` : null;

  useEffect(() => {
    if (!storageKey) {
      setJwt(null);
      return;
    }
    const cached = localStorage.getItem(storageKey);
    setJwt(cached);
  }, [storageKey]);

  const signIn = useCallback(async (): Promise<string | null> => {
    if (!address || !isConnected || !storageKey) return null;
    try {
      const { message } = await api.post<{ message: string }>(endpoints.siweNonce, {
        address: address.toLowerCase(),
      });
      const signature = await signMessageAsync({ message });
      const { token } = await api.post<{ token: string }>(endpoints.siweVerify, {
        address: address.toLowerCase(),
        signature,
      });
      localStorage.setItem(storageKey, token);
      setJwt(token);
      return token;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        localStorage.removeItem(storageKey);
      }
      return null;
    }
  }, [address, isConnected, signMessageAsync, storageKey]);

  const signOut = useCallback(() => {
    if (storageKey) localStorage.removeItem(storageKey);
    setJwt(null);
  }, [storageKey]);

  return { jwt, signIn, signOut };
}
