import { createPublicClient, decodeEventLog, http, parseAbiItem, type Address, type Hex } from "viem";
import type { Env } from "../env";

const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(address indexed user, address indexed token, uint256 amount, uint8 indexed purpose, bytes32 ref)",
);
const BURNED_EVENT = parseAbiItem(
  "event Burned(address indexed user, uint256 amount, address indexed referrer)",
);

function sameAddress(a: string | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

async function receiptLogs(env: Env, txHash: Hex) {
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 30_000, pollingInterval: 1_000 });
  if (receipt.status !== "success") throw new Error("transaction failed on chain");
  return receipt.logs.filter((log) => sameAddress(log.address, env.VAULT_ADDRESS));
}

export async function verifyVaultDeposit(env: Env, expected: {
  txHash: Hex;
  user: Address;
  token: Address;
  amount: bigint;
  purpose: number;
}): Promise<void> {
  const logs = await receiptLogs(env, expected.txHash);
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({ abi: [DEPOSITED_EVENT], data: log.data, topics: log.topics });
      const args = decoded.args as { user?: Address; token?: Address; amount?: bigint; purpose?: number };
      if (
        sameAddress(args.user, expected.user) &&
        sameAddress(args.token, expected.token) &&
        args.amount === expected.amount &&
        Number(args.purpose) === expected.purpose
      ) return;
    } catch {
      // not a Deposited event
    }
  }
  throw new Error("matching Vault.Deposited event not found");
}

export async function verifyVaultBurn(env: Env, expected: {
  txHash: Hex;
  user: Address;
  amount: bigint;
  referrer?: Address | null;
}): Promise<void> {
  const logs = await receiptLogs(env, expected.txHash);
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({ abi: [BURNED_EVENT], data: log.data, topics: log.topics });
      const args = decoded.args as { user?: Address; amount?: bigint; referrer?: Address };
      const referrerMatches = !expected.referrer || sameAddress(args.referrer, expected.referrer);
      if (sameAddress(args.user, expected.user) && args.amount === expected.amount && referrerMatches) return;
    } catch {
      // not a Burned event
    }
  }
  throw new Error("matching Vault.Burned event not found");
}