/**
 * 业务规则常量 — README v1.1 单一真相源。
 *
 * **规则**：所有"利率/比例/区间/分配"数字都从这里取，业务代码不要硬编码。
 * README 改版 → 这里改一处 → 全站生效。
 *
 * 单位约定：
 *   - 百分比一律用 basis points (bps)：1% = 100 bps
 *   - 时间戳用秒（unix）
 *   - 金额用 wei（18 decimals）
 */

// ===== §1.3 质押月化收益率 =====
export const STAKE_ASSETS = ["USDT", "HS", "LP"] as const;
export type StakeAsset = (typeof STAKE_ASSETS)[number];

export const STAKE_LOCK_MONTHS = [1, 3, 6, 12] as const;
export type StakeLockMonths = (typeof STAKE_LOCK_MONTHS)[number];

/**
 * 月化收益率（bps），README §1.3。
 * 后台可改 → Worker 写 stake_rates 表。前端展示用此默认表。
 */
export const STAKE_DEFAULT_RATES_BPS: Record<StakeAsset, Record<StakeLockMonths, number>> = {
  USDT: { 1: 50, 3: 200, 6: 400, 12: 800 },
  HS:   { 1: 50, 3: 200, 6: 400, 12: 800 },
  LP:   { 1: 100, 3: 300, 6: 1000, 12: 2400 },
};

// ===== §1.4 质押核心规则 =====
/** 到期收益的 5% HS 作为燃料销毁 */
export const STAKE_FUEL_BURN_BPS = 500;
/** 6 个月及以上享 5% 燃烧权重分红 */
export const STAKE_BURN_DIVIDEND_MIN_MONTHS = 6;
export const STAKE_BURN_DIVIDEND_BPS = 500;
/** 燃烧权重分红的 HS 最低持仓门槛（U 等值） */
export const STAKE_BURN_DIVIDEND_MIN_HS_USDT = 10;

// ===== §2.1 AI 量化套餐 =====
export const AI_TIERS = [
  { key: "genesis", label: "创世", usdt: 5000, stockGrantBps: 5000 }, // 50%
  { key: "glory", label: "荣耀", usdt: 2000, stockGrantBps: 2000 },   // 20%
  { key: "eternal", label: "永恒", usdt: 1000, stockGrantBps: 1000 }, // 10%
  { key: "shine", label: "鑫耀", usdt: 500, stockGrantBps: 500 },     // 5%
  { key: "pioneer", label: "开拓者", usdt: 100, stockGrantBps: 0 },   // 无赠送
] as const;
export type AiTierKey = (typeof AI_TIERS)[number]["key"];

// ===== §2.2 每日股票分红比例（bps） =====
export const AI_DIVIDEND_TIER_SHARE_BPS: Record<AiTierKey, number> = {
  genesis: 5600, // 56%
  glory: 2500,   // 25%
  eternal: 1200, // 12%
  shine: 600,    // 6%
  pioneer: 100,  // 1%
};

// ===== §2.3 双重 HS 空投 =====
/** 解锁门槛：日持股 500 股 */
export const AI_AIRDROP_MIN_DAILY_STOCK = 500;
/** 保底年化空投比例 */
export const AI_AIRDROP_BASE_APR_BPS = 500;
/** 燃烧权重空投比例 */
export const AI_AIRDROP_BURN_WEIGHT_BPS = 500;
/** HS 最低持有数量门槛（U 等值） */
export const AI_AIRDROP_MIN_HS_USDT = 10;

// ===== §2.4 套餐直推一次性返佣 =====
export const AI_REFERRAL_DIRECT_BPS: Record<AiTierKey, number> = {
  genesis: 1000, // 10%
  glory: 600,    // 6%
  eternal: 400,  // 4%
  shine: 200,    // 2%
  pioneer: 0,    // 无返佣
};

// ===== §2.4 每日股票三代返佣（bps）=====
export const AI_REFERRAL_3GEN_BPS: Record<AiTierKey, [number, number, number]> = {
  genesis: [1000, 600, 400], // 10% / 6% / 4%
  glory: [400, 300, 100],    // 4% / 3% / 1%
  eternal: [200, 100, 40],   // 2% / 1% / 0.4%
  shine: [0, 0, 0],
  pioneer: [0, 0, 0],
};

/**
 * §2.4(3) 三代股票返佣补充规则：
 *   - 直推购买返佣无等级压制
 *   - 三代股票返佣：仅下级等级高于自身时，对应股票收益减半
 */
export const AI_3GEN_DOWNGRADE_BPS = 5000; // 50%

// ===== §2.5 闪兑 =====
/** HS → 股票闪兑后锁仓 2 年（秒） */
export const AI_SWAP_LOCK_SECONDS = 2 * 365 * 24 * 3600;

// ===== §3 彩票（薄饼克隆） =====
/** 周奖池补给（HS） */
export const LOTTERY_WEEKLY_REFILL_HS = 100_000;
/** 门票价（USDT） — 后台可改 */
export const LOTTERY_DEFAULT_TICKET_USDT = 1;
/** 70% 入池 / 30% 黑洞 */
export const LOTTERY_TO_POOL_BPS = 7000;
export const LOTTERY_TO_BURN_BPS = 3000;

/** 命中前 N 位 → 占当期奖池比例（bps）。与 PancakeSwap LotteryV2 一致：左起连续前缀匹配，断点即止。 */
export const LOTTERY_PRIZE_BPS = {
  hit1: 200,    // 2%
  hit2: 300,    // 3%
  hit3: 500,    // 5%
  hit4Prefix: 1500,  // 15%
  hit5Prefix: 2500,  // 25%
  hit6All: 5000,     // 50%
} as const;

// ===== §4 燃烧生态 =====
/** §4.1 LP 滑点分红 70%/30% */
export const BURN_LP_DIVIDEND_HOLDER_BPS = 7000;
export const BURN_LP_DIVIDEND_TOP10_BPS = 3000;

/** §4.2 个人燃烧规则 */
export const BURN_PERSONAL_DOUBLE_OUT_BPS = 20000; // 双倍出局 = 200%

/** §4.3 燃烧资金分配 */
export const BURN_ALLOCATION_BPS = {
  blackHole: 5000,    // 50% 黑洞销毁
  weight: 2000,       // 20% 权重分红
  promotion: 1500,    // 15% 推广奖励（一代10/二代5）
  stake: 500,         // 5% 质押分红
  aiStock: 500,       // 5% AI 量化股票分红
  top10: 500,         // 5% 前十分红
} as const;

/** §4.3 推广奖励一/二代 */
export const BURN_PROMOTION_GEN1_BPS = 1000;
export const BURN_PROMOTION_GEN2_BPS = 500;
/** 激活推广奖励需销毁的 HS（U 等值） */
export const BURN_PROMOTION_ACTIVATE_USDT = 5;

/** §4.4 周榜结算 60% 当周 / 40% 滚下周 */
export const BURN_WEEKLY_PAYOUT_BPS = 6000;
export const BURN_WEEKLY_CARRYOVER_BPS = 4000;

/** §4.5 hotshort 账户空投门槛（U） */
export const BURN_AIRDROP_MIN_USDT = 1000;

// ===== 通用 =====
export const BPS_DENOMINATOR = 10_000;

/** 把 bps 换算成可读的百分比字符串："500" → "5%" */
export function bpsToPercent(bps: number): string {
  if (bps % 100 === 0) return `${bps / 100}%`;
  return `${(bps / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
