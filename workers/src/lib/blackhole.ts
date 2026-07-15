import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "../env";
import { requireSecret } from "../env";
import { createClaimSignature, type ClaimSignatureResponse } from "./claims";
import { deterministicNonce } from "./nonce";
import { readVaultNonceUsed } from "./vault-events";
import { readTokenBalance } from "./token-balance";
import { isTestMode, nowSeconds } from "./time";
import {
  LOTTERY_TO_BURN_BPS,
  BURN_ALLOCATION_BPS,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

/**
 * 黑洞欠烧结转：把账面上应销毁但仍留在 Vault 的 HS 定期链上转入 0x…dEaD。
 *
 * 应烧口径（README）：
 *   - §3 彩票：每张门票 30% 打入黑洞 → SUM(lottery_tickets.paid_hs) × 30%
 *   - §4.3 燃烧：每笔燃烧 50% 黑洞销毁 → SUM(burn_records.hs_amount) × 50%
 *   （质押燃料 5% 已在用户领取交易内直接转 dead，不在此列。）
 *
 * 执行方式：不改合约。Worker 用 signer 私钥给自己签一张 claim（收款人 = dead），
 * 再由 signer 账户发交易执行 Vault.claim → HS 链上转入黑洞，BscScan 可查。
 *
 * 幂等保证：nonce = deterministicNonce("blackhole", 已烧累计值)。已烧累计只在
 * 链上确认（usedNonces=true）后才增长，因此同一批欠烧无论重签/重发多少次都共用
 * 同一个 nonce，合约层保证至多成交一次，不可能重复销毁。
 */

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;
/** Vault.Claimed reason：黑洞销毁（1/3/4/5/6/7/8 已被业务占用） */
export const BLACKHOLE_CLAIM_REASON = 9;

const KEY_SETTLED = "blackhole_settled_hs";
const KEY_INFLIGHT = "blackhole_inflight";
const KEY_SCAN_BUCKET = "cron_last_blackhole_scan";
/** 低于 0.01 HS 不值得发一笔交易 */
const MIN_SETTLE_WEI = 10n ** 16n;
/** 签名 deadline 过后再留的安全边距，防边界竞态 */
const EXPIRE_MARGIN_SECONDS = 120;
/** 发起节流：15 分钟最多扫描/发起一次 */
const SCAN_INTERVAL_SECONDS = 900;

const VAULT_CLAIM_ABI = [
  {
    name: "claim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "reason", type: "uint8" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

interface Inflight {
  nonce: string;
  amount: string;
  deadline: number;
  txHash?: string;
}

export type BlackholeSettleResult =
  | { action: "idle" }
  | { action: "skipped"; why: string }
  | { action: "waiting"; nonce: string; txHash?: string }
  | { action: "finalized"; nonce: string; amountHs: string }
  | { action: "issued"; nonce: string; amountHs: string; txHash: string };

async function readConfig(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeConfig(env: Env, key: string, value: string, now: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'blackhole', ?)",
  )
    .bind(key, value, now)
    .run();
}

async function deleteConfig(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_config WHERE key = ?").bind(key).run();
}

async function readInflight(env: Env): Promise<Inflight | null> {
  const raw = await readConfig(env, KEY_INFLIGHT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Inflight;
    if (!/^\d+$/.test(parsed.nonce) || !/^\d+$/.test(parsed.amount)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 应烧累计（wei）：全量扫描票据与燃烧流水，来源即真相，无需增量计数。 */
async function computeOwedWei(env: Env): Promise<bigint> {
  const tickets = await env.DB.prepare("SELECT paid_hs FROM lottery_tickets").all<{ paid_hs: string }>();
  let lotteryPaid = 0n;
  for (const row of tickets.results ?? []) {
    if (/^\d+$/.test(row.paid_hs)) lotteryPaid += BigInt(row.paid_hs);
  }
  const burns = await env.DB.prepare("SELECT hs_amount FROM burn_records").all<{ hs_amount: string }>();
  let burnedHs = 0n;
  for (const row of burns.results ?? []) {
    if (/^\d+$/.test(row.hs_amount)) burnedHs += BigInt(row.hs_amount);
  }
  return (
    (lotteryPaid * BigInt(LOTTERY_TO_BURN_BPS)) / BigInt(BPS_DENOMINATOR) +
    (burnedHs * BigInt(BURN_ALLOCATION_BPS.blackHole)) / BigInt(BPS_DENOMINATOR)
  );
}

/** 用 signer 账户直接广播一笔 Vault.claim（黑洞销毁 / 到期未领补发共用） */
export async function sendClaimTx(env: Env, sig: ClaimSignatureResponse): Promise<Hex> {
  const account = privateKeyToAccount(requireSecret(env, "SIGNER_PRIVATE_KEY") as Hex);
  const chain = defineChain({
    id: Number(env.CHAIN_ID),
    name: env.CHAIN_NAME || "chain",
    nativeCurrency: {
      decimals: 18,
      name: env.NATIVE_CURRENCY_NAME || "BNB",
      symbol: env.NATIVE_CURRENCY_SYMBOL || "BNB",
    },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(env.RPC_URL) });
  // BSC 走 legacy gasPrice 交易最稳（EIP-1559 在 BSC 上 baseFee 恒 0，动态费率易被节点拒收）
  const publicClient = createPublicClient({ transport: http(env.RPC_URL) });
  const gasPrice = await publicClient.getGasPrice();
  return wallet.writeContract({
    address: env.VAULT_ADDRESS as Address,
    abi: VAULT_CLAIM_ABI,
    functionName: "claim",
    args: [
      sig.tokens,
      sig.recipients,
      sig.amounts.map((a) => BigInt(a)),
      BigInt(sig.nonce),
      BigInt(sig.deadline),
      sig.reason,
      sig.signature,
    ],
    gasPrice,
  });
}

/**
 * cron 每分钟调用。内部自带节流：
 *   - 有在途结转时只做确认/过期/补发，不发起新结转；
 *   - 无在途时每 15 分钟才扫描一次欠烧并发起。
 */
export async function settleBlackhole(env: Env): Promise<BlackholeSettleResult> {
  if (isTestMode(env)) return { action: "skipped", why: "test-mode" };
  if (!env.SIGNER_PRIVATE_KEY) return { action: "skipped", why: "signer key missing" };
  const now = await nowSeconds(env);

  // 1) 在途结转：确认成交 → 累计已烧；过期 → 作废重来；未广播成功 → 补发。
  const inflight = await readInflight(env);
  if (inflight) {
    const used = await readVaultNonceUsed(env, BigInt(inflight.nonce)).catch(() => null);
    if (used === null) return { action: "waiting", nonce: inflight.nonce, txHash: inflight.txHash };
    if (used) {
      const settled = BigInt((await readConfig(env, KEY_SETTLED)) ?? "0");
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'blackhole', ?)",
        ).bind(KEY_SETTLED, (settled + BigInt(inflight.amount)).toString(), now),
        env.DB.prepare("DELETE FROM admin_config WHERE key = ?").bind(KEY_INFLIGHT),
      ]);
      return { action: "finalized", nonce: inflight.nonce, amountHs: inflight.amount };
    }
    if (now > inflight.deadline + EXPIRE_MARGIN_SECONDS) {
      // 签名已过期，链上不可能再成交；作废后按同一 settled 基点重签（nonce 不变，天然防重）。
      await deleteConfig(env, KEY_INFLIGHT);
    } else if (!inflight.txHash) {
      // 上次广播失败，用库里既有签名补发。
      const { getExistingSignature } = await import("./claims");
      const sig = await getExistingSignature(env, BigInt(inflight.nonce), now);
      if (!sig) return { action: "waiting", nonce: inflight.nonce };
      try {
        const txHash = await sendClaimTx(env, sig);
        await writeConfig(env, KEY_INFLIGHT, JSON.stringify({ ...inflight, txHash }), now);
        return { action: "issued", nonce: inflight.nonce, amountHs: inflight.amount, txHash };
      } catch (e) {
        console.error("[blackhole] resend failed", (e as Error).message);
        return { action: "waiting", nonce: inflight.nonce };
      }
    } else {
      return { action: "waiting", nonce: inflight.nonce, txHash: inflight.txHash };
    }
  }

  // 2) 发起节流：15 分钟一个桶。
  const bucket = String(Math.floor(now / SCAN_INTERVAL_SECONDS));
  const prevBucket = await readConfig(env, KEY_SCAN_BUCKET);
  if (prevBucket === bucket) return { action: "idle" };
  await writeConfig(env, KEY_SCAN_BUCKET, bucket, now);

  // 3) 计算欠烧并发起结转。
  const owed = await computeOwedWei(env);
  const settled = BigInt((await readConfig(env, KEY_SETTLED)) ?? "0");
  const pending = owed - settled;
  if (pending < MIN_SETTLE_WEI) return { action: "idle" };

  const hsToken = env.HS_TOKEN.toLowerCase() as Address;
  const vaultBalance = await readTokenBalance(env, hsToken, env.VAULT_ADDRESS as Address).catch(() => null);
  if (vaultBalance === null) return { action: "skipped", why: "vault balance unavailable" };
  if (vaultBalance < pending) {
    console.error(`[blackhole] vault HS ${vaultBalance} < pending ${pending}, skip`);
    return { action: "skipped", why: "vault HS insufficient" };
  }

  const account = privateKeyToAccount(requireSecret(env, "SIGNER_PRIVATE_KEY") as Hex);
  const nonce = deterministicNonce("blackhole", settled.toString());
  const sig = await createClaimSignature(env, {
    user: account.address,
    payouts: [{ token: hsToken, recipient: DEAD_ADDRESS, amount: pending }],
    reason: BLACKHOLE_CLAIM_REASON,
    now,
    nonce,
  });
  await writeConfig(env, KEY_INFLIGHT, JSON.stringify({ nonce: sig.nonce, amount: pending.toString(), deadline: sig.deadline } satisfies Inflight), now);

  try {
    const txHash = await sendClaimTx(env, sig);
    await writeConfig(env, KEY_INFLIGHT, JSON.stringify({ nonce: sig.nonce, amount: pending.toString(), deadline: sig.deadline, txHash } satisfies Inflight), now);
    return { action: "issued", nonce: sig.nonce, amountHs: pending.toString(), txHash };
  } catch (e) {
    // 广播失败（gas 不足 / RPC 抖动）：保留在途记录，下一分钟用同一签名补发。
    console.error("[blackhole] send failed", (e as Error).message);
    return { action: "waiting", nonce: sig.nonce };
  }
}
