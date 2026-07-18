import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import type { Env } from "../env";
import { hsWeiToUsdtSnapshot } from "./pricing";

const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(address indexed user, address indexed token, uint256 amount, uint8 indexed purpose, bytes32 ref)",
);
const CLAIMED_EVENT = parseAbiItem(
  "event Claimed(address indexed user, address indexed token, uint256 amount, uint8 indexed reason, uint256 nonce)",
);
const BURNED_EVENT = parseAbiItem(
  "event Burned(address indexed user, uint256 amount, address indexed referrer)",
);
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const CURSOR_KEY = "indexer_last_block";
const MAX_BLOCK_RANGE = 2_000n;
const INITIAL_LOOKBACK_BLOCKS = 50_000n;

function configuredAddress(value: string | undefined, label: string): Address {
  const normalized = (value ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized) || normalized === "0x0000000000000000000000000000000000000000") {
    throw new Error(`invalid ${label}`);
  }
  return normalized as Address;
}

function confirmationDepth(env: Env): bigint {
  const text = env.INDEXER_CONFIRMATIONS?.trim() ?? "12";
  if (!/^\d+$/.test(text)) throw new Error("invalid INDEXER_CONFIRMATIONS");
  return BigInt(text);
}

/**
 * 每分钟 cron 触发：从上次游标向链上拉 Vault 事件，写入 D1。
 * P0 仅落地基础事件追踪，P1+ 各业务用游标确认订单状态。
 */
export async function syncVaultEvents(env: Env): Promise<{ from: bigint; to: bigint; count: number }> {
  const vault = configuredAddress(env.VAULT_ADDRESS, "VAULT_ADDRESS");
  const lpDividendSource = configuredAddress(env.LP_DIVIDEND_SOURCE_ADDRESS, "LP_DIVIDEND_SOURCE_ADDRESS");
  const usdtToken = configuredAddress(env.USDT_TOKEN, "USDT_TOKEN");

  const client = createPublicClient({ transport: http(env.RPC_URL) });

  const cursorRow = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?")
    .bind(CURSOR_KEY)
    .first<{ value: string }>();
  let from = cursorRow ? BigInt(cursorRow.value) : 0n;

  const tip = await client.getBlockNumber();
  const confirmations = confirmationDepth(env);
  const confirmedTip = tip > confirmations ? tip - confirmations : 0n;

  // 新库从已确认链头前 5 万块开始；先确定起点，再计算本批终点。
  if (from === 0n) from = confirmedTip > INITIAL_LOOKBACK_BLOCKS ? confirmedTip - INITIAL_LOOKBACK_BLOCKS : 0n;
  // 一次最多扫 2000 块，避免单次 cron 超时。
  const to = from + MAX_BLOCK_RANGE > confirmedTip ? confirmedTip : from + MAX_BLOCK_RANGE;
  if (from >= to) return { from, to, count: 0 };

  const [deposited, claimed, burned, lpTaxTransfers] = await Promise.all([
    client.getLogs({ address: vault, event: DEPOSITED_EVENT, fromBlock: from, toBlock: to }),
    client.getLogs({ address: vault, event: CLAIMED_EVENT, fromBlock: from, toBlock: to }),
    client.getLogs({ address: vault, event: BURNED_EVENT, fromBlock: from, toBlock: to }),
    client.getLogs({
      address: usdtToken,
      event: TRANSFER_EVENT,
      args: { from: lpDividendSource, to: vault },
      fromBlock: from,
      toBlock: to,
    }),
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
        "UPDATE reward_claims SET claimed = 1 WHERE claim_nonce = ? AND claimed = 0",
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
        "UPDATE burn_top10_settlements SET claimed = 1 WHERE user = ? AND claim_nonce = ? AND claimed = 0",
      )
        .bind(user, nonce)
        .run();
      await env.DB.prepare(
        "UPDATE reward_claims SET claimed = 1 WHERE user = ? AND claim_nonce = ? AND claimed = 0",
      )
        .bind(user, nonce)
        .run();
      await env.DB.prepare(
        "UPDATE referral_rewards SET claimed = 1 WHERE user = ? AND claim_nonce = ? AND claimed = 0",
      )
        .bind(user, nonce)
        .run();
      await env.DB.prepare(
        "UPDATE burn_records SET claimed_individual = 1 WHERE user = ? AND claimed_individual = 0",
      )
        .bind(user)
        .run();
      await env.DB.prepare(
        "UPDATE burn_personal_status SET total_personal_claimed_usdt = ?, out_at = COALESCE(out_at, ?), updated_at = ? WHERE user = ?",
      )
        .bind(log.args.amount.toString(), usedAt, usedAt, user)
        .run();
      // 出局后把份额并入「出局者权重池」（与 /burn/claim/personal/confirm 路径一致，幂等）。
      const { enterOutWeightPool } = await import("./burn-realtime");
      await enterOutWeightPool(env, user);
    }
  }

  // 燃烧记录入账（P3 会基于此分配 50/20/15/5/5/5，先记原始流水）
  for (const log of burned) {
    const id = `burn-${log.transactionHash}-${log.logIndex}`;
    const user = log.args.user!.toLowerCase();
    const exists = await env.DB.prepare("SELECT id FROM burn_records WHERE source_tx_hash = ?")
      .bind(log.transactionHash)
      .first<{ id: string }>();
    if (exists) continue;

    const amount = log.args.amount!;
    const snapshot = await hsWeiToUsdtSnapshot(env, amount);
    if (snapshot.usdtWei <= 0n || snapshot.priceWei <= 0n) continue;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO burn_records (id, user, hs_amount, usdt_value, hs_price_usdt_wei, referrer, burned_at, source_tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        user,
        amount.toString(),
        snapshot.usdtWei.toString(),
        snapshot.priceWei.toString(),
        log.args.referrer ? log.args.referrer.toLowerCase() : null,
        Math.floor(Date.now() / 1000),
        log.transactionHash,
      )
      .run();

    // 仅确保个人状态行存在；累计燃烧额与实时分配（权重/推广/黑洞）统一由
    // distributeBurnRealtime 在 cron 中处理，避免在此处与 record 双写导致重复累计。
    await env.DB.prepare(
      "INSERT OR IGNORE INTO burn_personal_status (user, updated_at) VALUES (?, ?)",
    )
      .bind(user, Math.floor(Date.now() / 1000))
      .run();
  }

  // HS 旧合约先把 LP 分红发给已登记的项目方 LP 钱包；该钱包转入 Vault 的
  // USDT Transfer(LP_DIVIDEND_SOURCE_ADDRESS -> VAULT_ADDRESS) 才计作 §4.1 LP 分红。
  for (const log of lpTaxTransfers) {
    const value = log.args.value;
    if (!value || value <= 0n) continue;
    const id = `lp-tax-${log.transactionHash}-${log.logIndex}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO lp_tax_receipts
         (id, tx_hash, log_index, amount_usdt, block_number, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        log.transactionHash,
        Number(log.logIndex),
        value.toString(),
        log.blockNumber.toString(),
        Math.floor(Date.now() / 1000),
      )
      .run();
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'indexer', ?)",
  )
    .bind(CURSOR_KEY, to.toString(), Math.floor(Date.now() / 1000))
    .run();

  return { from, to, count: deposited.length + claimed.length + burned.length + lpTaxTransfers.length };
}
