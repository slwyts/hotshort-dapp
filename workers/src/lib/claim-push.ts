import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "../env";
import { requireSecret } from "../env";
import { createClaimSignature, type ClaimPayout } from "./claims";
import { readVaultNonceUsed } from "./vault-events";
import { sendClaimTx } from "./blackhole";
import { isTestMode, nowSeconds } from "./time";

/**
 * 通用领取补发：用户请求了领取签名但 60 秒内没完成钱包上链的，由 signer
 * 复用**同一 nonce** 重签（user = signer、payouts 原样）并直接广播，把钱
 * 送到用户手里。用户端零改动、零操作。
 *
 * 防双发：Vault.usedNonces 全局去重——用户手里的原签名和系统补发共用一个
 * nonce，链上只可能成交一条，另一条自动 revert（NonceUsed）。
 *
 * 适用 reason：
 *   1 质押提取 / 3 彩票领奖 / 4 燃烧分红 / 5 AI 团队返佣 / 6 AI 空投 / 7 卖出 FXHO
 * 排除：
 *   8 个人燃烧出局 —— indexer 按链上事件的 user 回写出局状态，代发时事件
 *     user 是 signer 会写错账；该流程 nonce 每用户唯一且可重签，用户重新点
 *     领取即可恢复，无卡死风险。
 *   9 黑洞销毁 —— 由 settleBlackhole 自管在途状态，不能被抢跑。
 */

const PUSH_REASONS = "(1, 3, 4, 5, 6, 7)";
/** 签发后给用户自行上链的独占窗口；超过即补发 */
const AGE_BEFORE_PUSH_SECONDS = 60;
/** 单次 cron 最多补发笔数（限 gas 与子请求数） */
const MAX_PUSH_PER_TICK = 3;

type SignatureRow = {
  nonce: string;
  user: string;
  token: string;
  amount: string;
  reason: number;
  recipients_json: string | null;
  created_at: number;
};

function rowToPayouts(row: SignatureRow): ClaimPayout[] | null {
  if (row.recipients_json) {
    try {
      const parsed = JSON.parse(row.recipients_json) as { tokens?: string[]; recipients: string[]; amounts: string[] };
      if (Array.isArray(parsed.recipients) && parsed.recipients.length > 0 && parsed.recipients.length === parsed.amounts?.length) {
        return parsed.recipients.map((recipient, i) => ({
          token: (parsed.tokens?.[i] ?? row.token) as Address,
          recipient: recipient as Address,
          amount: BigInt(parsed.amounts[i]),
        }));
      }
    } catch { /* fallthrough */ }
  }
  if (/^\d+$/.test(row.amount) && BigInt(row.amount) > 0n) {
    return [{ token: row.token as Address, recipient: row.user as Address, amount: BigInt(row.amount) }];
  }
  return null;
}

export async function pushUnexecutedClaims(env: Env): Promise<{ pushed: number; healed: number }> {
  if (isTestMode(env)) return { pushed: 0, healed: 0 };
  if (!env.SIGNER_PRIVATE_KEY) return { pushed: 0, healed: 0 };
  const now = await nowSeconds(env);

  const rows = await env.DB.prepare(
    `SELECT nonce, user, token, amount, reason, recipients_json, created_at
       FROM claim_signatures
      WHERE used_at IS NULL AND reason IN ${PUSH_REASONS} AND created_at <= ?
      ORDER BY created_at ASC
      LIMIT 20`,
  )
    .bind(now - AGE_BEFORE_PUSH_SECONDS)
    .all<SignatureRow>();

  const account = privateKeyToAccount(requireSecret(env, "SIGNER_PRIVATE_KEY") as `0x${string}`);
  const signerAddress = account.address.toLowerCase();

  let pushed = 0;
  let healed = 0;
  for (const row of rows.results ?? []) {
    if (pushed >= MAX_PUSH_PER_TICK) break;
    if (!/^\d+$/.test(row.nonce)) continue;
    const nonce = BigInt(row.nonce);

    // 已上链（用户自领 / 上轮补发已成交）→ 标记 used_at 自愈退出扫描
    const used = await readVaultNonceUsed(env, nonce).catch(() => null);
    if (used === null) continue; // RPC 抖动，下轮再看
    if (used) {
      await env.DB.prepare("UPDATE claim_signatures SET used_at = ? WHERE nonce = ? AND used_at IS NULL")
        .bind(now, row.nonce)
        .run();
      healed++;
      continue;
    }

    const payouts = rowToPayouts(row);
    if (!payouts) {
      console.error(`[claim-push] nonce=${row.nonce} unparsable payouts, skip`);
      continue;
    }
    // 已是 signer 名下的签名（此前补发重签过）也照常走：同 nonce 重签幂等

    const sig = await createClaimSignature(env, {
      user: account.address,
      payouts,
      reason: row.reason,
      now,
      nonce,
    });
    try {
      const txHash = await sendClaimTx(env, sig);
      console.log(`[claim-push] reason=${row.reason} user=${row.user === signerAddress ? "(pushed)" : row.user} nonce=${row.nonce} tx=${txHash}`);
      pushed++;
    } catch (e) {
      // 广播失败下轮重试；同 nonce 重试不可能双发
      console.error(`[claim-push] send failed nonce=${row.nonce}`, (e as Error).message);
    }
  }
  return { pushed, healed };
}
