import { Hono } from "hono";
import { type Address, type Hex } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser, createStakeOrder, requireBoundUser } from "../lib/users";
import { getCurrentRateBps } from "../lib/rates";
import { nowSeconds } from "../lib/time";
import { createClaimSignature, getExistingSignature } from "../lib/claims";
import { deterministicNonce } from "../lib/nonce";
import { stakeAssetYieldWeiToHsWei, tokenForStakeAsset } from "../lib/pricing";
import { verifyVaultDeposit, verifyVaultClaim } from "../lib/vault-events";
import {
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  STAKE_FUEL_BURN_BPS,
  BPS_DENOMINATOR,
  type StakeAsset,
  type StakeLockMonths,
} from "@/lib/constants/business-rules";

export const stake = new Hono<{ Bindings: Env }>();

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

/**
 * GET /stake/rates  当前生效利率（前端表单展示用）。
 */
stake.get("/rates", async (c) => {
  const rs = await c.env.DB.prepare(
    "SELECT asset, lock_months, monthly_rate_bps FROM stake_rates",
  ).all<{ asset: string; lock_months: number; monthly_rate_bps: number }>();
  return c.json({ rates: rs.results ?? [] });
});

/**
 * GET /stake/orders  当前用户质押订单列表。
 */
stake.get("/orders", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const rs = await c.env.DB.prepare(
    `SELECT id, asset, amount, lock_months, monthly_rate_bps, started_at, matures_at, claimed, claim_tx_hash, source_tx_hash
       FROM stake_orders WHERE user = ? ORDER BY started_at DESC LIMIT 200`,
  )
    .bind(user)
    .all();
  return c.json({ orders: rs.results ?? [] });
});

/**
 * POST /stake/orders  创建一笔质押订单（前端已经在链上 deposit）。
 * 入参: { sourceTxHash, asset, amountWei, lockMonths, referrer? }
 * Worker 验证：tx 包含 Vault.Deposited(user, token, amountWei, purpose=1)。
 */
stake.post("/orders", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const bound = await requireBoundUser(c.env, user);
  if (!bound) return c.json({ error: "no upline" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    asset?: string;
    amountWei?: string;
    lockMonths?: number;
  };
  const asset = body.asset as StakeAsset;
  const months = body.lockMonths as StakeLockMonths;
  if (!STAKE_ASSETS.includes(asset)) return c.json({ error: "bad asset" }, 400);
  if (!STAKE_LOCK_MONTHS.includes(months)) return c.json({ error: "bad lock_months" }, 400);
  if (!body.amountWei || !/^\d+$/.test(body.amountWei)) return c.json({ error: "bad amount" }, 400);
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }

  const exists = await c.env.DB.prepare("SELECT id FROM stake_orders WHERE source_tx_hash = ?")
    .bind(body.sourceTxHash)
    .first<{ id: string }>();
  if (exists) return c.json({ error: "tx already recorded" }, 409);

  const amount = BigInt(body.amountWei);
  const token = tokenForStakeAsset(c.env, asset);
  await verifyVaultDeposit(c.env, {
    txHash: body.sourceTxHash as Hex,
    user: user as Address,
    token,
    amount,
    purpose: 1,
  });

  await upsertUser(c.env, user);
  const monthlyRateBps = await getCurrentRateBps(c.env, asset, months);

  const id = await createStakeOrder(c.env, {
    user,
    asset,
    amountWei: body.amountWei,
    lockMonths: months,
    monthlyRateBps,
    sourceTxHash: body.sourceTxHash,
  });

  return c.json({ id, monthlyRateBps });
});

/**
 * POST /stake/claim  到期领取签名（本金+收益一并折 HS 发放）。
 * 入参: { orderId }
 * 出参: EIP-712 签名，payouts 包含用户实收（本金折 HS + 收益折 HS - 5% 燃料）
 *       和 0xdEaD 销毁的燃料部分，一次交易完成。
 */
stake.post("/claim", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { orderId?: string };
  if (!body.orderId) return c.json({ error: "bad orderId" }, 400);

  const order = await c.env.DB.prepare(
    `SELECT id, user, asset, amount, lock_months, monthly_rate_bps, matures_at, claimed
       FROM stake_orders WHERE id = ? AND user = ?`,
  )
    .bind(body.orderId, user)
    .first<{
      id: string;
      user: string;
      asset: string;
      amount: string;
      lock_months: number;
      monthly_rate_bps: number;
      matures_at: number;
      claimed: number;
    }>();

  if (!order) return c.json({ error: "order not found" }, 404);
  if (order.claimed) return c.json({ error: "already claimed" }, 400);
  const now = await nowSeconds(c.env);
  if (now < order.matures_at) {
    return c.json({ error: "not matured" }, 400);
  }

  const nonce = deterministicNonce("stake", order.id);

  // 已有有效签名 → 直接返回（用户重试）
  const existing = await getExistingSignature(c.env, nonce, now);
  if (existing) return c.json(existing);

  const principal = BigInt(order.amount);

  // 收益（本位）= 本金 × 月利率 × 月数
  const yieldAsset =
    (principal * BigInt(order.monthly_rate_bps) * BigInt(order.lock_months)) /
    BigInt(BPS_DENOMINATOR);

  // 收益折 HS
  const yieldHs = await stakeAssetYieldWeiToHsWei(c.env, order.asset as StakeAsset, yieldAsset);
  if (yieldHs <= 0n) return c.json({ error: "yield unavailable" }, 503);

  // 本金折 HS
  const principalHs = await stakeAssetYieldWeiToHsWei(c.env, order.asset as StakeAsset, principal);
  if (principalHs <= 0n) return c.json({ error: "principal price unavailable" }, 503);

  // 5% 燃料仅对收益部分扣
  const fuelHs = (yieldHs * BigInt(STAKE_FUEL_BURN_BPS)) / BigInt(BPS_DENOMINATOR);
  const userHs = principalHs + yieldHs - fuelHs;

  const hsToken = c.env.HS_TOKEN.toLowerCase() as Address;
  const reason = 1; // STAKE_YIELD

  const claim = await createClaimSignature(c.env, {
    user: user as Address,
    token: hsToken,
    payouts: fuelHs > 0n
      ? [
        { recipient: user as Address, amount: userHs },
        { recipient: DEAD_ADDRESS, amount: fuelHs },
      ]
      : [{ recipient: user as Address, amount: userHs }],
    reason,
    now,
    nonce,
  });

  // 只记录 nonce（用于索引器/confirm 回写），不乐观标记 claimed
  await c.env.DB.prepare("UPDATE stake_orders SET claim_nonce = ? WHERE id = ?")
    .bind(claim.nonce, order.id)
    .run();

  return c.json({
    ...claim,
    claimableHs: userHs.toString(),
    fuelBurnHs: fuelHs.toString(),
    yieldHs: yieldHs.toString(),
    principalHs: principalHs.toString(),
    yieldAssetAmount: yieldAsset.toString(),
    yieldAsset: order.asset,
  });
});

/**
 * POST /stake/confirm  前端 tx 成功后即时回调，标记已领取。
 * 入参: { txHash, orderId }
 */
stake.post("/confirm", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { txHash?: string; orderId?: string };
  if (!body.txHash || !/^0x[a-fA-F0-9]{64}$/.test(body.txHash)) return c.json({ error: "bad tx hash" }, 400);
  if (!body.orderId) return c.json({ error: "bad orderId" }, 400);

  const order = await c.env.DB.prepare(
    "SELECT id, claim_nonce FROM stake_orders WHERE id = ? AND user = ?",
  )
    .bind(body.orderId, user)
    .first<{ id: string; claim_nonce: string | null }>();
  if (!order) return c.json({ error: "order not found" }, 404);

  const expectedNonce = order.claim_nonce ? BigInt(order.claim_nonce) : undefined;
  await verifyVaultClaim(c.env, {
    txHash: body.txHash as Hex,
    user: user as Address,
    token: c.env.HS_TOKEN.toLowerCase() as Address,
    reason: 1,
    nonce: expectedNonce,
  });

  await c.env.DB.prepare("UPDATE stake_orders SET claimed = 1 WHERE id = ?")
    .bind(order.id)
    .run();

  return c.json({ confirmed: true });
});
