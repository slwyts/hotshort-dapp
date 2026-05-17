import { LOTTERY_PRIZE_BPS, BPS_DENOMINATOR } from "@/lib/constants/business-rules";

export type HitKind = keyof typeof LOTTERY_PRIZE_BPS;

/**
 * 计算彩票命中规则（README §3）。
 *
 * 命中口径：
 *   - hit6All       前 6 位全部相同（=== winning）
 *   - hit5Prefix    前 5 位顺序相同
 *   - hit4Prefix    前 4 位顺序相同
 *   - hit3 / hit2 / hit1
 *       README 没说"前 N 位"，只说"命中 N 位"。我们按薄饼的"无序匹配 N 位"理解：
 *       门票号 6 位中至少 N 个数字与 winning 同位置或同值匹配；
 *       为公平采用更严格的"同位置匹配 N 位"——前 4/5/6 位用顺序前缀，1/2/3 位用任意位置匹配数。
 *
 * 取最高奖励档（一张票只领一个奖项）。
 */
export function computeHit(ticket: string, winning: string): { kind: HitKind | null; bps: number } {
  if (!/^\d{6}$/.test(ticket) || !/^\d{6}$/.test(winning)) return { kind: null, bps: 0 };

  // 前缀匹配位数
  let prefix = 0;
  for (let i = 0; i < 6; i++) {
    if (ticket[i] === winning[i]) prefix++;
    else break;
  }

  if (prefix === 6) return { kind: "hit6All", bps: LOTTERY_PRIZE_BPS.hit6All };
  if (prefix === 5) return { kind: "hit5Prefix", bps: LOTTERY_PRIZE_BPS.hit5Prefix };
  if (prefix === 4) return { kind: "hit4Prefix", bps: LOTTERY_PRIZE_BPS.hit4Prefix };

  // 1/2/3 位：同位置任意命中（不要求连续）
  let positional = 0;
  for (let i = 0; i < 6; i++) if (ticket[i] === winning[i]) positional++;

  if (positional >= 3) return { kind: "hit3", bps: LOTTERY_PRIZE_BPS.hit3 };
  if (positional === 2) return { kind: "hit2", bps: LOTTERY_PRIZE_BPS.hit2 };
  if (positional === 1) return { kind: "hit1", bps: LOTTERY_PRIZE_BPS.hit1 };
  return { kind: null, bps: 0 };
}

/** 把 bps 应用到当期奖池得到具体奖金（HS） */
export function prizeFromPool(poolHs: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  return (poolHs * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
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
