/**
 * 共用合约地址常量。
 * BSC 主网地址沿用 genesis-hotshort 仓库；测试网/本地走部署脚本写出的 deployed.<network>.json。
 */

export const HS_TOKEN = "0xcf4907621f0d9803c7288423b4303226b696b533";
export const USDT_TOKEN = "0x55d398326f99059ff775485246999027b3197955";
export const PANCAKE_PAIR_HS_USDT = "0x2398e858ac6ad9dea4496bc6ecacea4ce77cc67e";

/** genesis-hotshort 收款 EOA — 仅用于扫描创世节点历史 transfer */
export const GENESIS_RECEIVER = "0x6800981c52dd2379fe3c3a16f6b07594eb32bc55";

/** 本仓库部署后填入；优先读环境变量 */
export const HOTSHORT_VAULT =
  (process.env.NEXT_PUBLIC_VAULT_ADDRESS?.toLowerCase() as `0x${string}` | undefined) ??
  ("0x0000000000000000000000000000000000000000" as const);

/** 业务用途枚举（与合约 Deposited.purpose 对齐） */
export const DEPOSIT_PURPOSE = {
  STAKE: 1,
  AI_PACKAGE: 2,
  LOTTERY: 3,
  BURN: 4,
  SWAP_HS_TO_STOCK: 5,
} as const;

/** Claim 原因（与合约 Claimed.reason 对齐） */
export const CLAIM_REASON = {
  STAKE_YIELD: 1,
  STOCK_DIVIDEND: 2,
  LOTTERY_PRIZE: 3,
  BURN_DIVIDEND: 4,
  REFERRAL: 5,
  HS_AIRDROP: 6,
  ADMIN_REFUND: 7,
} as const;
