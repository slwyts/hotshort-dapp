import type { Env } from "../env";
import { ulid } from "./ulid";
import { nowSeconds } from "./time";
import {
  BURN_ALLOCATION_BPS,
  BURN_PROMOTION_GEN1_BPS,
  BURN_PROMOTION_GEN2_BPS,
  BURN_PROMOTION_ACTIVATE_USDT,
  BPS_DENOMINATOR,
} from "@/lib/constants/business-rules";

/**
 * §4 燃烧奖励实时化（每笔燃烧即时分配）。
 *
 * 项目方口径：燃烧奖励有两个来源——
 *   (A) 前十分红：每周抢榜，由 settleBurnRound 周期结算（本文件不处理）。
 *   (B) 其余分红：用户燃烧当下实时发放。
 *
 * 本文件负责 (B) 中可实时化的三类：
 *   - 权重分红 20%：MasterChef 累加器，**仅在「出局者」之间**按累计燃烧 U 价值占比分配。
 *     未出局者不享受权重分红（他们享受 LP 交易税分红，见 lp-dividend.ts）。
 *     无任何出局者时，权重池累积进 carryover，待首个用户出局时一次性并入。
 *   - 推广奖励 15%：一代 10%、二代 5%，固定收款人，燃烧瞬间直接入账（未激活/无上级归官方）。
 *   - 黑洞销毁 50%：全局计数器实时记账；链上实际销毁由 blackhole.ts 定期把累计额转入 0x…dEaD。
 *
 * 质押分红 5%、AI 股票分红 5%、前十分红 5% 的份额随质押/持股频繁变动或依赖排名，
 * 仍由 settleBurnRound 按当周燃烧池快照分配（资金本身是实时进入池子的）。
 */

const ACC_PRECISION = 10n ** 18n;

const KEY_ACC = "burn_weight_acc_per_share";
// 权重分红只统计「出局者」份额总和。
const KEY_OUT_TOTAL_SHARE = "burn_weight_out_total_share";
// 无出局者时，权重池暂存于此，待首个出局者并入。
const KEY_CARRYOVER = "burn_weight_carryover_usdt";
const KEY_BLACKHOLE = "burn_blackhole_total_usdt";

interface PersonalRow {
  totalHs: bigint;
  totalUsdt: bigint;
  debt: bigint;
  pending: bigint;
  out: number | null;
}

async function readConfigBig(env: Env, key: string): Promise<bigint> {
  const row = await env.DB.prepare("SELECT value FROM admin_config WHERE key = ?").bind(key).first<{ value: string }>();
  const text = row?.value ?? "0";
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

async function writeConfigBig(env: Env, key: string, value: bigint, now: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, 'burn-realtime', ?)",
  )
    .bind(key, value.toString(), now)
    .run();
}

async function ownerAddress(env: Env): Promise<string> {
  const { readVaultOwner } = await import("./vault-owner");
  return (await readVaultOwner(env)).toLowerCase();
}

async function loadPersonal(env: Env, user: string, now: number): Promise<PersonalRow> {
  const row = await env.DB.prepare(
    "SELECT total_burned_hs, total_burned_usdt, weight_reward_debt, weight_pending_usdt, out_at FROM burn_personal_status WHERE user = ?",
  )
    .bind(user)
    .first<{ total_burned_hs: string; total_burned_usdt: string; weight_reward_debt: string; weight_pending_usdt: string; out_at: number | null }>();
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO burn_personal_status (user, updated_at) VALUES (?, ?)").bind(user, now).run();
    return { totalHs: 0n, totalUsdt: 0n, debt: 0n, pending: 0n, out: null };
  }
  return {
    totalHs: BigInt(row.total_burned_hs),
    totalUsdt: BigInt(row.total_burned_usdt),
    debt: BigInt(row.weight_reward_debt),
    pending: BigInt(row.weight_pending_usdt),
    out: row.out_at,
  };
}

async function isOut(env: Env, user: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT out_at FROM burn_personal_status WHERE user = ?").bind(user).first<{ out_at: number | null }>();
  return !!row?.out_at;
}

async function burnTotalUsdt(env: Env, user: string): Promise<bigint> {
  const row = await env.DB.prepare("SELECT total_burned_usdt FROM burn_personal_status WHERE user = ?").bind(user).first<{ total_burned_usdt: string }>();
  return BigInt(row?.total_burned_usdt ?? "0");
}

async function directUpperOf(env: Env, user: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT level1 FROM referral_paths WHERE user = ?").bind(user).first<{ level1: string | null }>();
  return row?.level1?.toLowerCase() ?? null;
}

async function insertReferralReward(env: Env, params: {
  user: string;
  sourceUser: string;
  kind: string;
  amount: bigint;
  basis: bigint;
  sourceRef: string;
  now: number;
}): Promise<void> {
  if (params.amount <= 0n) return;
  await env.DB.prepare(
    `INSERT INTO referral_rewards
       (id, user, source_user, kind, reward_token, reward_amount, basis_amount, basis_kind, source_ref, earned_at)
     VALUES (?, ?, ?, ?, 'USDT', ?, ?, 'burn-usdt', ?, ?)`,
  )
    .bind(ulid(), params.user, params.sourceUser, params.kind, params.amount.toString(), params.basis.toString(), params.sourceRef, params.now)
    .run();
}

/**
 * 处理所有尚未实时分配的燃烧记录（distributed = 0），按时间顺序逐笔应用累加器。
 * 幂等保证：每行处理完置 distributed = 1，record/indexer 双写经 source_tx_hash 去重后只剩一行。
 */
export async function distributeBurnRealtime(env: Env): Promise<{ processed: number }> {
  const rows = (await env.DB.prepare(
    "SELECT id, user, hs_amount, usdt_value, referrer FROM burn_records WHERE distributed = 0 ORDER BY burned_at ASC, id ASC",
  ).all<{ id: string; user: string; hs_amount: string; usdt_value: string; referrer: string | null }>()).results ?? [];
  if (rows.length === 0) return { processed: 0 };

  const now = await nowSeconds(env);
  const official = await ownerAddress(env);
  const minPromotionBurn = BigInt(BURN_PROMOTION_ACTIVATE_USDT) * 10n ** 18n;

  let acc = await readConfigBig(env, KEY_ACC);
  let outTotalShare = await readConfigBig(env, KEY_OUT_TOTAL_SHARE);
  let carryover = await readConfigBig(env, KEY_CARRYOVER);
  let blackhole = await readConfigBig(env, KEY_BLACKHOLE);
  let processed = 0;

  for (const row of rows) {
    const user = row.user.toLowerCase();
    const x = BigInt(row.usdt_value);
    const hs = BigInt(row.hs_amount);
    if (x <= 0n) {
      await env.DB.prepare("UPDATE burn_records SET distributed = 1 WHERE id = ?").bind(row.id).run();
      processed++;
      continue;
    }

    const ps = await loadPersonal(env, user, now);

    const newTotalUsdt = ps.totalUsdt + x;
    const newTotalHs = ps.totalHs + hs;

    // 1) 本笔权重池 20% 只分给「出局者」。
    //    - 若当前已有出局者：按出局份额总和累加 acc。
    //    - 若暂无出局者：暂存进 carryover，待首个出局者并入。
    const weightPool = (x * BigInt(BURN_ALLOCATION_BPS.weight)) / BigInt(BPS_DENOMINATOR);
    if (outTotalShare > 0n) {
      acc += (weightPool * ACC_PRECISION) / outTotalShare;
    } else {
      carryover += weightPool;
    }

    // 2) 推广奖励 15%：一代 10%、二代 5%，实时直发。
    const gen1 = row.referrer ? row.referrer.toLowerCase() : official;
    const gen2 = gen1 === official ? official : (await directUpperOf(env, gen1)) ?? official;
    const gen1Active = gen1 === official || (!(await isOut(env, gen1)) && (await burnTotalUsdt(env, gen1)) >= minPromotionBurn);
    const gen2Active = gen2 === official || (!(await isOut(env, gen2)) && (await burnTotalUsdt(env, gen2)) >= minPromotionBurn);
    await insertReferralReward(env, {
      user: gen1Active ? gen1 : official,
      sourceUser: user,
      kind: "burn-gen1",
      amount: (x * BigInt(BURN_PROMOTION_GEN1_BPS)) / BigInt(BPS_DENOMINATOR),
      basis: x,
      sourceRef: row.id,
      now,
    });
    await insertReferralReward(env, {
      user: gen2Active ? gen2 : official,
      sourceUser: user,
      kind: "burn-gen2",
      amount: (x * BigInt(BURN_PROMOTION_GEN2_BPS)) / BigInt(BPS_DENOMINATOR),
      basis: x,
      sourceRef: row.id,
      now,
    });

    // 3) 黑洞销毁 50% 实时记账。
    blackhole += (x * BigInt(BURN_ALLOCATION_BPS.blackHole)) / BigInt(BPS_DENOMINATOR);

    // 4) 更新本人累计燃烧额（LP 分红 / 日后出局份额都依赖此值）。
    //    若用户已出局，其权重份额已在 outTotalShare 内，需同步追加新增份额并对齐债务，
    //    使其继续吃到后续权重池。未出局者不进入权重份额，债务保持为 0。
    if (ps.out) {
      // 先结算既有份额到 pending，再把新增份额并入出局份额池。
      const pendingAccrued = ps.pending + (ps.totalUsdt * acc) / ACC_PRECISION - ps.debt;
      outTotalShare += x;
      const newDebt = (newTotalUsdt * acc) / ACC_PRECISION;
      await env.DB.prepare(
        "UPDATE burn_personal_status SET total_burned_hs = ?, total_burned_usdt = ?, weight_reward_debt = ?, weight_pending_usdt = ?, updated_at = ? WHERE user = ?",
      )
        .bind(newTotalHs.toString(), newTotalUsdt.toString(), newDebt.toString(), pendingAccrued.toString(), now, user)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE burn_personal_status SET total_burned_hs = ?, total_burned_usdt = ?, weight_reward_debt = '0', weight_pending_usdt = '0', updated_at = ? WHERE user = ?",
      )
        .bind(newTotalHs.toString(), newTotalUsdt.toString(), now, user)
        .run();
    }

    await env.DB.prepare("UPDATE burn_records SET distributed = 1 WHERE id = ?").bind(row.id).run();
    processed++;
  }

  await writeConfigBig(env, KEY_ACC, acc, now);
  await writeConfigBig(env, KEY_OUT_TOTAL_SHARE, outTotalShare, now);
  await writeConfigBig(env, KEY_CARRYOVER, carryover, now);
  await writeConfigBig(env, KEY_BLACKHOLE, blackhole, now);
  return { processed };
}

/**
 * 只读：计算用户当前可领的权重分红（已结算 pending + 未结算累加器部分）。
 * 仅「出局者」享有权重分红；未出局用户一律返回 0。
 * 不持久化，供 /burn/me 等读接口展示。
 */
export async function computeWeightClaimable(env: Env, user: string): Promise<bigint> {
  const row = await env.DB.prepare(
    "SELECT total_burned_usdt, weight_reward_debt, weight_pending_usdt, out_at FROM burn_personal_status WHERE user = ?",
  )
    .bind(user.toLowerCase())
    .first<{ total_burned_usdt: string; weight_reward_debt: string; weight_pending_usdt: string; out_at: number | null }>();
  if (!row) return 0n;
  if (!row.out_at) return 0n; // 未出局者不享受权重分红
  const acc = await readConfigBig(env, KEY_ACC);
  const share = BigInt(row.total_burned_usdt);
  const debt = BigInt(row.weight_reward_debt);
  const pending = BigInt(row.weight_pending_usdt);
  const live = pending + (share * acc) / ACC_PRECISION - debt;
  return live > 0n ? live : 0n;
}

/**
 * 写：用户首次出局时，把其累计燃烧份额并入「出局者份额池」并对齐债务。
 * 若此前 carryover 中累积了权重池（无出局者期间），且此用户是首个出局者，
 * 则把 carryover 一次性记入其待领权重，避免债务对齐时抵消掉。
 * 必须在设置 out_at 之后、settleWeightToRewardClaim 之前调用。
 */
export async function enterOutWeightPool(env: Env, user: string): Promise<void> {
  const normalized = user.toLowerCase();
  const now = await nowSeconds(env);
  const row = await env.DB.prepare(
    "SELECT total_burned_usdt, weight_reward_debt, weight_joined_out, out_at FROM burn_personal_status WHERE user = ?",
  )
    .bind(normalized)
    .first<{ total_burned_usdt: string; weight_reward_debt: string; weight_joined_out: number | null; out_at: number | null }>();
  if (!row || !row.out_at) return; // 必须已出局
  if (row.weight_joined_out) return; // 幂等：已并入过

  const share = BigInt(row.total_burned_usdt);
  let acc = await readConfigBig(env, KEY_ACC);
  let outTotalShare = await readConfigBig(env, KEY_OUT_TOTAL_SHARE);
  const carryover = await readConfigBig(env, KEY_CARRYOVER);

  const previousOutTotalShare = outTotalShare;
  let joinedPending = 0n;

  // 先把本人份额并入出局份额池。
  outTotalShare += share;

  // 若有滚存池且本人是首个出局者，把 carryover 直接给本人待领；
  // 否则按累加器分给已在池中的出局者。
  if (carryover > 0n && outTotalShare > 0n) {
    if (previousOutTotalShare === 0n) {
      joinedPending = carryover;
    } else {
      acc += (carryover * ACC_PRECISION) / previousOutTotalShare;
    }
    await writeConfigBig(env, KEY_CARRYOVER, 0n, now);
  }

  // 本人债务对齐当前 acc，从此刻起吃后续权重池；首个出局者的历史 carryover 已放入 pending。
  const debt = (share * acc) / ACC_PRECISION;

  await writeConfigBig(env, KEY_ACC, acc, now);
  await writeConfigBig(env, KEY_OUT_TOTAL_SHARE, outTotalShare, now);
  await env.DB.prepare(
    "UPDATE burn_personal_status SET weight_reward_debt = ?, weight_pending_usdt = ?, weight_joined_out = 1, updated_at = ? WHERE user = ?",
  )
    .bind(debt.toString(), joinedPending.toString(), now, normalized)
    .run();
}

/**
 * 写：在领取前把累加器收益结算成一条 burn-weight reward_claims 行，复用既有签名领取路径。
 * 仅「出局者」可结算权重分红；未出局用户直接返回 0。
 * 结算后重置 pending、对齐债务，避免重复计入。返回本次结算金额。
 */
export async function settleWeightToRewardClaim(env: Env, user: string): Promise<bigint> {
  const normalized = user.toLowerCase();
  const now = await nowSeconds(env);
  const row = await env.DB.prepare(
    "SELECT total_burned_usdt, weight_reward_debt, weight_pending_usdt, out_at FROM burn_personal_status WHERE user = ?",
  )
    .bind(normalized)
    .first<{ total_burned_usdt: string; weight_reward_debt: string; weight_pending_usdt: string; out_at: number | null }>();
  if (!row) return 0n;
  if (!row.out_at) return 0n; // 未出局者不享受权重分红
  const acc = await readConfigBig(env, KEY_ACC);
  const share = BigInt(row.total_burned_usdt);
  const debt = BigInt(row.weight_reward_debt);
  const pending = BigInt(row.weight_pending_usdt);
  const live = pending + (share * acc) / ACC_PRECISION - debt;
  if (live <= 0n) return 0n;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO reward_claims (id, user, kind, reward_token, reward_amount, round, source_ref, created_at)
     VALUES (?, ?, 'burn-weight', 'USDT', ?, NULL, ?, ?)`,
  )
    .bind(ulid(), normalized, live.toString(), `burn-weight:${normalized}:${ulid()}`, now)
    .run();

  // 结算后：pending 清零，债务对齐当前份额×acc。
  const newDebt = (share * acc) / ACC_PRECISION;
  await env.DB.prepare(
    "UPDATE burn_personal_status SET weight_pending_usdt = '0', weight_reward_debt = ?, updated_at = ? WHERE user = ?",
  )
    .bind(newDebt.toString(), now, normalized)
    .run();
  return live;
}
