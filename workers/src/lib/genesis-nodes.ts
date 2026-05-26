import type { Env } from "../env";
import { AI_TIERS, type AiTierKey } from "@/lib/constants/business-rules";
import { recordAiPackageOrder } from "./ai-orders";

const VALID_TIERS = new Set<AiTierKey>(AI_TIERS.map((tier) => tier.key as AiTierKey));

interface GenesisNodeRow {
  tier: string;
  imported_at: number;
}

export function normalizeAiTier(value: string): AiTierKey | null {
  return VALID_TIERS.has(value as AiTierKey) ? value as AiTierKey : null;
}

export async function importGenesisNode(env: Env, params: {
  address: string;
  tier: AiTierKey;
  source: "csv" | "onchain-scan";
  importedAt: number;
  importedBy: string;
}): Promise<{ inserted: boolean; orderCreated: boolean }> {
  const address = params.address.toLowerCase();
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO genesis_nodes (address, tier, source, imported_at, imported_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(address, params.tier, params.source, params.importedAt, params.importedBy.toLowerCase())
    .run();
  const nodeInserted = (inserted.meta?.changes ?? 0) > 0;

  const existing = nodeInserted ? null : await env.DB.prepare(
    "SELECT tier, imported_at FROM genesis_nodes WHERE address = ?",
  )
    .bind(address)
    .first<GenesisNodeRow>();
  const effectiveTier = nodeInserted ? params.tier : normalizeAiTier(existing?.tier ?? "");
  if (!effectiveTier) return { inserted: nodeInserted, orderCreated: false };

  const order = await recordAiPackageOrder(env, {
    user: address,
    tier: effectiveTier,
    sourceTxHash: `genesis-import:${address}:${effectiveTier}`,
    createdAt: nodeInserted ? params.importedAt : existing?.imported_at,
    creditReferral: false,
  });
  return { inserted: nodeInserted, orderCreated: order.created };
}