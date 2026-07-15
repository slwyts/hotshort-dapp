import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "../env";
import { requireSecret } from "../env";
import { createClaimSignature } from "./claims";
import { readVaultNonceUsed } from "./vault-events";
import { sendClaimTx } from "./blackhole";
import { isTestMode, nowSeconds } from "./time";

/**
 * FXHO 卖出未领自动补发。
 *
 * 卖出流程当场扣股票并签发领取签名，由用户自己上链领取。用户没完成领取
 * （拒签/关页面/交易失败）时，本任务在卖出 60 秒后自动补发：signer 给自己
 * 签一张 claim（收款人 = 客户地址，与黑洞销毁同一机制），把 HS 直接打到
 * 客户钱包，客户无需任何操作，前端零改动。
 *
 * 防双发（关键设计）：补发签名**复用卖单原本的 claim nonce**。Vault 的
 * usedNonces 全局去重——用户自领和系统补发共用一个 nonce，链上只可能成交
 * 一条，另一条自动 revert（NonceUsed）。因此补发无需等原签名过期，60 秒
 * 即可安全介入；重签/重发任意次也不可能重复到账。
 */

const REASON_STOCK_SALE = 7;
/** 卖出后给用户自领的独占窗口；超过即补发 */
const AGE_BEFORE_PUSH_SECONDS = 60;
/** 单次 cron 最多补发的卖单数（限 gas 与子请求数） */
const MAX_PUSH_PER_TICK = 3;

type PendingSale = {
  id: string;
  user: string;
  hs_out: string;
  sold_at: number;
  claim_nonce: string | null;
};

export async function pushExpiredStockSalePayouts(env: Env): Promise<{ pushed: number; healed: number }> {
  if (isTestMode(env)) return { pushed: 0, healed: 0 };
  if (!env.SIGNER_PRIVATE_KEY) return { pushed: 0, healed: 0 };
  const now = await nowSeconds(env);

  const rows = await env.DB.prepare(
    `SELECT id, user, hs_out, sold_at, claim_nonce
       FROM stock_sales
      WHERE claimed_at IS NULL AND sold_at <= ?
      ORDER BY sold_at ASC
      LIMIT 20`,
  )
    .bind(now - AGE_BEFORE_PUSH_SECONDS)
    .all<PendingSale>();

  let pushed = 0;
  let healed = 0;
  for (const sale of rows.results ?? []) {
    if (pushed >= MAX_PUSH_PER_TICK) break;
    if (!/^\d+$/.test(sale.hs_out) || BigInt(sale.hs_out) <= 0n) continue;
    // 没有 nonce 的卖单不能补发：脱离原 nonce 就失去了与用户自领签名的互斥，可能双发
    if (!sale.claim_nonce || !/^\d+$/.test(sale.claim_nonce)) {
      console.error(`[stock-push] sale=${sale.id} missing claim_nonce, skip`);
      continue;
    }
    const nonce = BigInt(sale.claim_nonce);

    // 已上链（用户自领或此前补发已成交）→ 自愈标记，防 indexer 漏扫
    const used = await readVaultNonceUsed(env, nonce).catch(() => null);
    if (used === null) continue; // RPC 抖动，下轮再看
    if (used) {
      await env.DB.prepare("UPDATE stock_sales SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
        .bind(now, sale.id)
        .run();
      healed++;
      continue;
    }

    const account = privateKeyToAccount(requireSecret(env, "SIGNER_PRIVATE_KEY") as `0x${string}`);
    const sig = await createClaimSignature(env, {
      user: account.address,
      payouts: [{
        token: env.HS_TOKEN.toLowerCase() as Address,
        recipient: sale.user as Address,
        amount: BigInt(sale.hs_out),
      }],
      reason: REASON_STOCK_SALE,
      now,
      nonce,
    });
    try {
      const txHash = await sendClaimTx(env, sig);
      console.log(`[stock-push] sale=${sale.id} user=${sale.user} hs=${sale.hs_out} tx=${txHash}`);
      pushed++;
      // claimed_at 交给下一轮 usedNonces 自愈 / indexer 按 nonce 回填，成交才算数
    } catch (e) {
      // 广播失败下轮重试；与用户自领共用 nonce，怎么重试都不可能双发
      console.error(`[stock-push] send failed sale=${sale.id}`, (e as Error).message);
    }
  }
  return { pushed, healed };
}
