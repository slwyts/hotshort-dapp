import type { Env } from "../env";
import { AI_TIERS, BPS_DENOMINATOR, type AiTierKey } from "@/lib/constants/business-rules";
import { addStock, bigintWei, getStockPriceUsdt, usdtToStockWei } from "./stocks";
import { createAiStockReleaseSchedule } from "./ai-releases";
import { recordDirectReferral } from "./referral";
import { upsertUser } from "./users";
import { nowSeconds } from "./time";
import { ulid } from "./ulid";

const TIER_MAP = new Map(AI_TIERS.map((tier) => [tier.key as AiTierKey, tier]));

export async function recordAiPackageOrder(env: Env, params: {
  user: string;
  tier: AiTierKey;
  sourceTxHash: string;
  createdAt?: number;
  creditReferral?: boolean;
}): Promise<{
  created: boolean;
  id: string | null;
  tier: AiTierKey;
  usdtIn: string;
  stockGranted: string;
  stockPriceUsdt: number;
}> {
  const tier = TIER_MAP.get(params.tier);
  if (!tier) throw new Error("bad tier");
  if (!params.sourceTxHash) throw new Error("bad source ref");

  const existing = await env.DB.prepare("SELECT id, usdt_in, stock_granted FROM ai_orders WHERE source_tx_hash = ?")
    .bind(params.sourceTxHash)
    .first<{ id: string; usdt_in: string; stock_granted: string }>();
  const stockPrice = await getStockPriceUsdt(env);
  if (existing) {
    return {
      created: false,
      id: existing.id,
      tier: params.tier,
      usdtIn: existing.usdt_in,
      stockGranted: existing.stock_granted,
      stockPriceUsdt: stockPrice,
    };
  }

  const user = params.user.toLowerCase();
  const usdtInWei = bigintWei(tier.usdt);
  const stockGrantUsdt = (tier.usdt * tier.stockGrantBps) / BPS_DENOMINATOR;
  const stockGrantWei = usdtToStockWei(stockGrantUsdt, stockPrice);
  const id = ulid();
  const createdAt = params.createdAt ?? await nowSeconds(env);

  await upsertUser(env, user);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_orders (id, user, tier, usdt_in, stock_granted, created_at, source_tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user, params.tier, usdtInWei.toString(), stockGrantWei.toString(), createdAt, params.sourceTxHash)
    .run();
  if ((inserted.meta?.changes ?? 0) <= 0) {
    return {
      created: false,
      id,
      tier: params.tier,
      usdtIn: usdtInWei.toString(),
      stockGranted: stockGrantWei.toString(),
      stockPriceUsdt: stockPrice,
    };
  }

  if (stockGrantWei > 0n) {
    await addStock(env, user, stockGrantWei, true);
    await createAiStockReleaseSchedule(env, {
      orderId: id,
      user,
      totalStock: stockGrantWei,
      createdAt,
    });
  }

  if (params.creditReferral ?? true) {
    await recordDirectReferral(env, { buyer: user, usdtIn: usdtInWei, orderId: id });
  }

  return {
    created: true,
    id,
    tier: params.tier,
    usdtIn: usdtInWei.toString(),
    stockGranted: stockGrantWei.toString(),
    stockPriceUsdt: stockPrice,
  };
}