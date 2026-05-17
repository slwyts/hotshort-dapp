import { Hono } from "hono";
import { type Address } from "viem";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser, createStakeOrder } from "../lib/users";
import { getCurrentRateBps } from "../lib/rates";
import { signClaim } from "../lib/sign";
import { ulid } from "../lib/ulid";
import { requireSecret } from "../env";
import {
  STAKE_ASSETS,
  STAKE_LOCK_MONTHS,
  STAKE_FUEL_BURN_BPS,
  BPS_DENOMINATOR,
  type StakeAsset,
  type StakeLockMonths,
} from "@/lib/constants/business-rules";

export const stake = new Hono<{ Bindings: Env }>();

const HS_TOKEN_FALLBACK = "0xcF4907621f0d9803c7288423B4303226b696B533";

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
 * Worker 验证：tx 包含 Vault.Deposited(user, token, amountWei, purpose=1, ref=keccak('stake'+sourceTxHash))。
 * 简化版（P1）：信任前端提交，indexer 后续补充对账。
 */
stake.post("/orders", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    sourceTxHash?: string;
    asset?: string;
    amountWei?: string;
    lockMonths?: number;
    referrer?: string;
  };
  const asset = body.asset as StakeAsset;
  const months = body.lockMonths as StakeLockMonths;
  if (!STAKE_ASSETS.includes(asset)) return c.json({ error: "bad asset" }, 400);
  if (!STAKE_LOCK_MONTHS.includes(months)) return c.json({ error: "bad lock_months" }, 400);
  if (!body.amountWei || !/^\d+$/.test(body.amountWei)) return c.json({ error: "bad amount" }, 400);
  if (!body.sourceTxHash || !/^0x[a-fA-F0-9]{64}$/.test(body.sourceTxHash)) {
    return c.json({ error: "bad tx hash" }, 400);
  }

  await upsertUser(c.env, user, body.referrer ?? null);
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
 * POST /stake/claim  到期领取签名。
 * 入参: { orderId }
 * 出参: 两份 EIP-712 签名 —— 一份发用户，一份直接打入 0xdEaD 销毁 5% HS 燃料。
 *   注意：合约只支持单签名 claim，所以 5% 销毁这一步走 admin signer 单独打到 0xdEaD（withdrawTo）。
 *   为保持架构对称，这里只签 95% 的用户领取签名；销毁 5% HS 由 cron 或 admin 手动触发。
 *   - 收益币种 = HS（按 README §1.1 "到期收益以 HS 发放"）
 *   - 收益金额 = 本金 (USDT 等值) * monthlyRateBps * lockMonths / BPS_DENOMINATOR / hsPriceUsdt
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
  if (Math.floor(Date.now() / 1000) < order.matures_at) {
    return c.json({ error: "not matured" }, 400);
  }

  // 收益（USDT 等值）= 本金 * monthly_rate * months
  const principal = BigInt(order.amount);
  const yieldUsdt =
    (principal * BigInt(order.monthly_rate_bps) * BigInt(order.lock_months)) /
    BigInt(BPS_DENOMINATOR);

  // 取 HS 价格（USDT 计价）从 oracle 缓存读
  const priceRow = await c.env.DB.prepare(
    "SELECT value FROM admin_config WHERE key = 'hs_price_snapshot'",
  ).first<{ value: string }>();
  const hsPrice = priceRow ? Number(priceRow.value) : 0.001;
  if (hsPrice <= 0) return c.json({ error: "hs price unavailable" }, 503);

  // yieldHs = yieldUsdt / hsPrice
  // 整型保护：用 1e9 精度做近似
  const PRECISION = 10n ** 9n;
  const priceScaled = BigInt(Math.floor(hsPrice * 1e9));
  if (priceScaled === 0n) return c.json({ error: "hs price zero" }, 503);
  const yieldHs = (yieldUsdt * PRECISION) / priceScaled;

  // 5% 燃料：用户实际拿 95%，5% 由 cron 销毁
  const fuelHs = (yieldHs * BigInt(STAKE_FUEL_BURN_BPS)) / BigInt(BPS_DENOMINATOR);
  const userHs = yieldHs - fuelHs;

  const hsToken = (c.env.HS_TOKEN || HS_TOKEN_FALLBACK) as Address;
  const vault = c.env.VAULT_ADDRESS as Address;
  const chainId = Number(c.env.CHAIN_ID);
  const pk = requireSecret(c.env, "SIGNER_PRIVATE_KEY") as `0x${string}`;
  const nonce = BigInt("0x" + ulid().slice(0, 16));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const reason = 1; // STAKE_YIELD

  const signature = await signClaim(pk, chainId, vault, {
    user: user as Address,
    token: hsToken,
    amount: userHs,
    nonce,
    deadline,
    reason,
  });

  await c.env.DB.prepare(
    `INSERT INTO claim_signatures (nonce, user, token, amount, reason, deadline, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      nonce.toString(),
      user,
      hsToken.toLowerCase(),
      userHs.toString(),
      reason,
      Number(deadline),
      signature,
      Math.floor(Date.now() / 1000),
    )
    .run();

  // 标记订单已发签名（实际链上消费由 indexer 监听 Claimed → 写 used_at；此处先乐观更新）
  await c.env.DB.prepare("UPDATE stake_orders SET claimed = 1 WHERE id = ?")
    .bind(order.id)
    .run();

  return c.json({
    token: hsToken,
    amount: userHs.toString(),
    fuelBurnHs: fuelHs.toString(),
    nonce: nonce.toString(),
    deadline: Number(deadline),
    reason,
    signature,
  });
});
