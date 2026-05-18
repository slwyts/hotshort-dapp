/**
 * 业务用途枚举（与合约 Deposited.purpose 对齐）
 */
export const DEPOSIT_PURPOSE = {
  STAKE: 1,
  AI_PACKAGE: 2,
  LOTTERY: 3,
  BURN: 4,
  SWAP_HS_TO_STOCK: 5,
} as const;

/**
 * Claim 原因（与合约 Claimed.reason 对齐）
 */
export const CLAIM_REASON = {
  STAKE_YIELD: 1,
  STOCK_DIVIDEND: 2,
  LOTTERY_PRIZE: 3,
  BURN_DIVIDEND: 4,
  REFERRAL: 5,
  HS_AIRDROP: 6,
  ADMIN_REFUND: 7,
} as const;
