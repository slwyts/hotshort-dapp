import type { Env } from "../env";
import { importGenesisNode, normalizeAiTier } from "./genesis-nodes";

const BSC_API_URL = "https://api.bscscan.com/api";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const RECEIVER = "0x6800981c52dd2379fe3c3a16f6b07594eb32bc55";

/** 5 档套餐金额（USDT 全价 / 7 折预售价），任意命中即识别 */
const TIER_AMOUNTS: Record<string, number[]> = {
  genesis: [5000, 3500],
  glory: [2000, 1600],
  eternal: [1000, 900],
  shine: [500, 475],
  pioneer: [100, 98],
};
const TOLERANCE = 0.05;

interface BscscanTx {
  hash: string;
  from: string;
  to: string;
  value: string; // wei (USDT 18 decimals)
  contractAddress: string;
  timeStamp: string;
  isError: string;
}

function matchTier(usdt: number): string | null {
  for (const [tier, amounts] of Object.entries(TIER_AMOUNTS)) {
    for (const a of amounts) {
      if (Math.abs(usdt - a) / a <= TOLERANCE) return tier;
    }
  }
  return null;
}

/**
 * 扫 BscScan 上 RECEIVER 的 ERC20 token transfer，过滤出 USDT 入账并按金额匹配套餐。
 * 一次最多拉 10000 条（BscScan 单页上限）。
 */
export async function scanGenesisTransfers(env: Env, importer: string): Promise<{ inserted: number; scanned: number; ordersCreated: number }> {
  if (!env.BSCSCAN_API_KEY) throw new Error("BSCSCAN_API_KEY not set");
  const url = `${BSC_API_URL}?module=account&action=tokentx&contractaddress=${USDT}&address=${RECEIVER}&page=1&offset=10000&sort=asc&apikey=${env.BSCSCAN_API_KEY}`;
  const r = await fetch(url);
  const json = (await r.json()) as { status: string; message: string; result: BscscanTx[] };
  if (json.status !== "1" && !Array.isArray(json.result)) {
    throw new Error(`bscscan: ${json.message}`);
  }
  const txs = (json.result || []).filter(
    (t) => t.to.toLowerCase() === RECEIVER && t.isError === "0",
  );

  let inserted = 0;
  let ordersCreated = 0;
  for (const tx of txs) {
    const usdt = Number(BigInt(tx.value)) / 1e18;
    const tier = normalizeAiTier(matchTier(usdt) ?? "");
    if (!tier) continue;
    const addr = tx.from.toLowerCase();
    const res = await importGenesisNode(env, {
      address: addr,
      tier,
      source: "onchain-scan",
      importedAt: Number(tx.timeStamp),
      importedBy: importer,
    });
    if (res.inserted) inserted++;
    if (res.orderCreated) ordersCreated++;
  }

  return { inserted, scanned: txs.length, ordersCreated };
}
