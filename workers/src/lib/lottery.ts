import { LOTTERY_PRIZE_BPS, BPS_DENOMINATOR } from "@/lib/constants/business-rules";

export type HitKind = keyof typeof LOTTERY_PRIZE_BPS;

/**
 * 计算彩票命中规则（README §3，与 PancakeSwap LotteryV2 一致）。
 *
 * 命中口径：**严格左起连续前缀匹配**。从第 1 位开始逐位比对，遇到第一个不同立即停止。
 *   - 第 1 位就不同 → 0 位 → 不获奖
 *   - 第 2 位起断开 → 命中前 1 位 (hit1)
 *   - 直到 6 位全中 → hit6All
 *
 * 一张票仅领最高档奖。
 */
export function computeHit(ticket: string, winning: string): { kind: HitKind | null; bps: number } {
  if (!/^\d{6}$/.test(ticket) || !/^\d{6}$/.test(winning)) return { kind: null, bps: 0 };

  let prefix = 0;
  for (let i = 0; i < 6; i++) {
    if (ticket[i] === winning[i]) prefix++;
    else break;
  }

  switch (prefix) {
    case 6: return { kind: "hit6All", bps: LOTTERY_PRIZE_BPS.hit6All };
    case 5: return { kind: "hit5Prefix", bps: LOTTERY_PRIZE_BPS.hit5Prefix };
    case 4: return { kind: "hit4Prefix", bps: LOTTERY_PRIZE_BPS.hit4Prefix };
    case 3: return { kind: "hit3", bps: LOTTERY_PRIZE_BPS.hit3 };
    case 2: return { kind: "hit2", bps: LOTTERY_PRIZE_BPS.hit2 };
    case 1: return { kind: "hit1", bps: LOTTERY_PRIZE_BPS.hit1 };
    default: return { kind: null, bps: 0 };
  }
}

/** 把 bps 应用到当期奖池得到具体奖金（HS） */
export function prizeFromPool(poolHs: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  return (poolHs * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
}

/**
 * 后台配置的数量字符串 → wei。纯 BigInt 运算：
 * 之前用 Number*1e18 转换，1000000 会变成 999999999999999983222784（浮点精度）。
 */
export function configAmountToWei(raw: string | null | undefined, fallback: number): bigint {
  const text = (raw ?? String(fallback)).trim();
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text);
  if (!m) return BigInt(fallback) * 10n ** 18n;
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
}

export function bytesToDigits6(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let n = 0n;
  for (const b of arr.subarray(0, 8)) n = n * 256n + BigInt(b);
  return (n % 1_000_000n).toString().padStart(6, "0");
}

export async function sha256Digits6(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return bytesToDigits6(hash);
}
