import type { Env } from "../env";
import { AI_TIERS, type AiTierKey } from "@/lib/constants/business-rules";
import { recordAiPackageOrder } from "./ai-orders";
import { upsertUser } from "./users";

const VALID_TIERS = new Set<AiTierKey>(AI_TIERS.map((tier) => tier.key as AiTierKey));
const TIER_ALIASES: Record<string, AiTierKey> = {
  genesis: "genesis",
  founder: "genesis",
  "5000": "genesis",
  "5000u": "genesis",
  创世: "genesis",
  创世节点: "genesis",
  创世5000: "genesis",
  创世5000u: "genesis",
  glory: "glory",
  "2000": "glory",
  "2000u": "glory",
  荣耀: "glory",
  荣耀2000: "glory",
  荣耀2000u: "glory",
  eternal: "eternal",
  "1000": "eternal",
  "1000u": "eternal",
  永恒: "eternal",
  永恒1000: "eternal",
  永恒1000u: "eternal",
  shine: "shine",
  "500": "shine",
  "500u": "shine",
  鑫耀: "shine",
  星耀: "shine",
  鑫耀500: "shine",
  鑫耀500u: "shine",
  星耀500: "shine",
  星耀500u: "shine",
  pioneer: "pioneer",
  "100": "pioneer",
  "100u": "pioneer",
  开拓者: "pioneer",
  开拓者100: "pioneer",
  开拓者100u: "pioneer",
};

interface GenesisNodeRow {
  tier: string;
  imported_at: number;
}

export function normalizeAiTier(value: string): AiTierKey | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  return TIER_ALIASES[normalized] ?? (VALID_TIERS.has(normalized as AiTierKey) ? normalized as AiTierKey : null);
}

function normalizeReferrer(value: string | null | undefined, user: string): string | null {
  const ref = (value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ref)) return null;
  return ref === user.toLowerCase() ? null : ref;
}

async function wouldCreateReferralCycle(env: Env, user: string, referrer: string): Promise<boolean> {
  const target = user.toLowerCase();
  let cursor = referrer.toLowerCase();
  for (let depth = 0; depth < 10; depth++) {
    if (cursor === target) return true;
    const row = await env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
      .bind(cursor)
      .first<{ referrer: string | null }>();
    if (!row?.referrer) return false;
    cursor = row.referrer.toLowerCase();
  }
  return false;
}

export async function importGenesisNode(env: Env, params: {
  address: string;
  tier: AiTierKey;
  source: "csv" | "onchain-scan";
  importedAt: number;
  importedBy: string;
  referrer?: string | null;
}): Promise<{ inserted: boolean; orderCreated: boolean; referrerBound: boolean }> {
  const address = params.address.toLowerCase();
  const referrer = normalizeReferrer(params.referrer, address);
  let referrerBound = false;

  if (referrer && !(await wouldCreateReferralCycle(env, address, referrer))) {
    const before = await env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
      .bind(address)
      .first<{ referrer: string | null }>();
    await upsertUser(env, address, referrer);
    const after = await env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
      .bind(address)
      .first<{ referrer: string | null }>();
    referrerBound = !before?.referrer && after?.referrer === referrer;
  }

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
  if (!effectiveTier) return { inserted: nodeInserted, orderCreated: false, referrerBound };

  const order = await recordAiPackageOrder(env, {
    user: address,
    tier: effectiveTier,
    sourceTxHash: `genesis-import:${address}:${effectiveTier}`,
    createdAt: nodeInserted ? params.importedAt : existing?.imported_at,
    creditReferral: false,
  });
  return { inserted: nodeInserted, orderCreated: order.created, referrerBound };
}
