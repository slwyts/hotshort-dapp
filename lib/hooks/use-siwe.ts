"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { api, endpoints, ApiError } from "@/lib/api";

const STORAGE_PREFIX = "hotshort_jwt_";
const signInRequests = new Map<string, Promise<string | null>>();

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

function isExpired(token: string): boolean {
  try {
    const payload = JSON.parse(decodeBase64Url(token.split(".")[1] ?? "")) as { exp?: number };
    return typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

function getCachedToken(storageKey: string): string | null {
  const cached = localStorage.getItem(storageKey);
  if (!cached) return null;
  if (!isExpired(cached)) return cached;
  localStorage.removeItem(storageKey);
  return null;
}

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
    setJwt(getCachedToken(storageKey));
  }, [storageKey]);

  const signIn = useCallback(async (): Promise<string | null> => {
    if (!address || !isConnected || !storageKey) return null;
    const cached = getCachedToken(storageKey);
    if (cached) {
      setJwt(cached);
      return cached;
    }

    const pending = signInRequests.get(storageKey);
    if (pending) {
      const token = await pending;
      if (token) setJwt(token);
      return token;
    }

    const request = (async () => {
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
    })().finally(() => {
      signInRequests.delete(storageKey);
    });

    signInRequests.set(storageKey, request);
    return request;
  }, [address, isConnected, signMessageAsync, storageKey]);

  const signOut = useCallback(() => {
    if (storageKey) localStorage.removeItem(storageKey);
    setJwt(null);
  }, [storageKey]);

  return { jwt, signIn, signOut };
}
