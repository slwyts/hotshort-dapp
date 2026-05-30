import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import type { Env } from "../env";

const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(address indexed user, address indexed token, uint256 amount, uint8 indexed purpose, bytes32 ref)",
);
const CLAIMED_EVENT = parseAbiItem(
  "event Claimed(address indexed user, address indexed token, uint256 amount, uint8 indexed reason, uint256 nonce)",
);
const BURNED_EVENT = parseAbiItem(
  "event Burned(address indexed user, uint256 amount, address indexed referrer)",
);

const CURSOR_KEY = "indexer_last_block";

/**
 * 每分钟 cron 触发：从上次游标向链上拉 Vault 事件，写入 D1。
 * P0 仅落地基础事件追踪，P1+ 各业务用游标确认订单状态。
 */
export async function syncVaultEvents(env: Env): Promise<{ from: bigint; to: bigint; count: number }> {
  const vault = env.VAULT_ADDRESS as Address;
  if (!/^0x[a-fA-F0-9]{40}$/.test(vault) || vault === "0x0000000000000000000000000000000000000000") {
    return { from: 0n, to: 0n, count: 0 };
  }

  const client = createPublicClient({ transport: http(env.RPC_URL) });

  const cursorRow = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?")
    .bind(CURSOR_KEY)
    .first<{ value: string }>();
  let from = cursorRow ? BigInt(cursorRow.value) : 0n;

  const tip = await client.getBlockNumber();
  // 一次最多扫 2000 块，避免单次 cron 超时
  const to = from + 2000n > tip ? tip : from + 2000n;
  if (from === 0n) from = tip > 50_000n ? tip - 50_000n : 0n;
  if (from >= to) return { from, to, count: 0 };

  const [deposited, claimed, burned] = await Promise.all([
    client.getLogs({ address: vault, event: DEPOSITED_EVENT, fromBlock: from, toBlock: to }),
    client.getLogs({ address: vault, event: CLAIMED_EVENT, fromBlock: from, toBlock: to }),
    client.getLogs({ address: vault, event: BURNED_EVENT, fromBlock: from, toBlock: to }),
  ]);

  // 确认 claim 链上消费 → 标记各业务表
  for (const log of claimed) {
    const nonce = log.args.nonce?.toString();
    const reason = Number(log.args.reason);
    if (!nonce) continue;
    const usedAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE claim_signatures SET used_at = ? WHERE nonce = ? AND used_at IS NULL",
    )
      .bind(usedAt, nonce)
      .run();

    // reason=1 STAKE_YIELD → stake_orders
    if (reason === 1) {
      await env.DB.prepare(
        "UPDATE stake_orders SET claimed = 1 WHERE claim_nonce = ? AND claimed = 0",
      )
        .bind(nonce)
        .run();
    }
    // reason=3 LOTTERY_PRIZE → lottery_tickets
    if (reason === 3) {
      await env.DB.prepare(
        "UPDATE lottery_tickets SET claimed = 1 WHERE claim_nonce = ? AND claimed = 0",
      )
        .bind(nonce)
        .run();
    }
    // reason=4 BURN_DIVIDEND → 多表
    if (reason === 4) {
      await env.DB.prepare(
        "UPDATE burn_top10_settlements SET claimed = 1 WHERE claim_nonce = ? AND claimed = 0",
      )
        .bind(nonce)
        .run();
      await env.DB.prepare(
        "UPDATE referral_rewards SET claimed = 1 WHERE claim_nonce = ? AND claimed = 0",
      )
        .bind(nonce)
        .run();
    }
    // reason=5 AI_REFERRAL → referral_rewards
    if (reason === 5) {
      await env.DB.prepare(
        "UPDATE referral_rewards SET claimed = 1 WHERE claim_nonce = ? AND claimed = 0",
      )
        .bind(nonce)
        .run();
    }
    // reason=6 AI_AIRDROP → reward_claims
    if (reason === 6) {
      await env.DB.prepare(
        "UPDATE reward_claims SET claimed = 1 WHERE claim_nonce = ? AND claimed = 0",
      )
        .bind(nonce)
        .run();
    }

    await env.DB.prepare(
      "UPDATE stock_sales SET claimed_at = ?, claim_tx_hash = ? WHERE claim_nonce = ? AND claimed_at IS NULL",
    )
      .bind(usedAt, log.transactionHash, nonce)
      .run();
    if (Number(log.args.reason) === 8 && log.args.user && log.args.amount) {
      const user = log.args.user.toLowerCase();
      await env.DB.prepare(
        "UPDATE burn_records SET claimed_individual = 1 WHERE user = ? AND claimed_individual = 0",
      )
        .bind(user)
        .run();
      await env.DB.prepare(
        "UPDATE burn_personal_status SET total_personal_claimed_hs = ?, out_at = COALESCE(out_at, ?), updated_at = ? WHERE user = ?",
      )
        .bind(log.args.amount.toString(), usedAt, usedAt, user)
        .run();
    }
  }

  // 燃烧记录入账（P3 会基于此分配 50/20/15/5/5/5，先记原始流水）
  for (const log of burned) {
    const id = `burn-${log.transactionHash}-${log.logIndex}`;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO burn_records (id, user, hs_amount, referrer, burned_at, source_tx_hash) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        log.args.user!.toLowerCase(),
        log.args.amount!.toString(),
        log.args.referrer ? log.args.referrer.toLowerCase() : null,
        Math.floor(Date.now() / 1000),
        log.transactionHash,
      )
      .run();
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'indexer', ?)",
  )
    .bind(CURSOR_KEY, to.toString(), Math.floor(Date.now() / 1000))
    .run();

  return { from, to, count: deposited.length + claimed.length + burned.length };
}
