"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api, endpoints } from "@/lib/api";

/**
 * 轻量服务器时间 hook。
 * 定期轮询 /oracle/server-time，返回 nowSeconds（受后端时间偏移影响）。
 * 用于替代 Date.now() 做业务到期判断。
 */
export function useServerTime(pollMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  const mounted = useRef(true);

  const fetch = useCallback(async () => {
    try {
      const r = await api.get<{ nowSeconds: number }>(endpoints.serverTime);
      if (mounted.current) setNow(r.nowSeconds);
    } catch {
      /* 静默失败，保留上一次值 */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetch();
    const i = setInterval(() => { void fetch(); }, pollMs);
    return () => {
      mounted.current = false;
      clearInterval(i);
    };
  }, [fetch, pollMs]);

  return now;
}
