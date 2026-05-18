import type { RuntimeConfig } from "./runtime-config";

/**
 * 服务端在 RootLayout 里同步 await 一次，把结果作为 prop 注入到 Web3Provider。
 * 客户端不应直接调用此函数；要在组件内拿配置请用 useRuntimeConfig()。
 */
export async function fetchRuntimeConfig(workerUrl: string): Promise<RuntimeConfig> {
  if (!workerUrl) throw new Error("NEXT_PUBLIC_WORKER_URL 未配置");
  const url = `${workerUrl.replace(/\/$/, "")}/config`;
  const res = await fetch(url, { next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`fetch /config failed: ${res.status}`);
  return (await res.json()) as RuntimeConfig;
}
