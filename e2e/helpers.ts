import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI, VAULT_ABI } from "../lib/contracts/abis";
import { ANVIL_CHAIN_ID, ANVIL_RPC, HS_TOKEN, USDT_TOKEN } from "./constants";

export const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";

export const localChain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: "Anvil BSC Fork",
  nativeCurrency: { decimals: 18, name: "BNB", symbol: "BNB" },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

export const publicClient = createPublicClient({ chain: localChain, transport: http(ANVIL_RPC) });

type TestAccount = {
  address: `0x${string}`;
  privateKey: Hex;
};

export async function rpcCall<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`[${method}] ${json.error.message ?? "RPC error"}`);
  return json.result as T;
}

export function accountClient(accountInfo: TestAccount) {
  const account = privateKeyToAccount(accountInfo.privateKey as Hex);
  const walletClient = createWalletClient({ account, chain: localChain, transport: http(ANVIL_RPC) });
  return { account, walletClient };
}

export function getVaultAddress(): Address {
  if (process.env.NEXT_PUBLIC_VAULT_ADDRESS) return process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address;
  const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const match = envLocal.match(/^NEXT_PUBLIC_VAULT_ADDRESS=(0x[a-fA-F0-9]{40})$/m);
  if (!match) throw new Error("NEXT_PUBLIC_VAULT_ADDRESS not found; run scripts/dev-local.sh first");
  return match[1] as Address;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) as T : ({} as T);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  return body;
}

export async function apiStatus(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function signIn(accountInfo: TestAccount): Promise<string> {
  const { account } = accountClient(accountInfo);
  const nonce = await apiRequest<{ message: string }>("/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ address: account.address }),
  });
  const signature = await account.signMessage({ message: nonce.message });
  const verified = await apiRequest<{ token: string }>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address: account.address, signature }),
  });
  return verified.token;
}

export function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export async function latestBlockTimestamp(): Promise<number> {
  const block = await rpcCall<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
  return Number(BigInt(block.timestamp));
}

export async function resetE2eState(nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  await apiRequest("/__test/reset", { method: "POST", body: JSON.stringify({ nowSeconds }) });
}

export async function advanceTime(seconds: number): Promise<void> {
  await rpcCall("evm_increaseTime", [seconds]);
  await rpcCall("evm_mine");
  await apiRequest("/__test/time/advance", { method: "POST", body: JSON.stringify({ seconds }) });
}

function storageSlot(address: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [address, slot]));
}

function storageValue(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

export async function setTokenBalance(token: Address, holder: Address, balance: bigint, balanceSlot: bigint): Promise<void> {
  await rpcCall("anvil_setStorageAt", [token, storageSlot(holder, balanceSlot), storageValue(balance)]);
}

export async function fundStakeLifecycleAccount(user: Address, vault: Address): Promise<void> {
  await rpcCall("anvil_setBalance", [user, "0x56BC75E2D63100000"]);
  await setTokenBalance(USDT_TOKEN as Address, user, parseEther("10000"), 1n);
  await setTokenBalance(HS_TOKEN as Address, user, parseEther("10000"), 0n);
  await setTokenBalance(HS_TOKEN as Address, vault, parseEther("1000000"), 0n);
}

export async function depositToVault(accountInfo: TestAccount, token: Address, amount: bigint, purpose: number): Promise<Hex> {
  const vault = getVaultAddress();
  const { walletClient } = accountClient(accountInfo);
  const approveHash = await walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [vault, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  const depositHash = await walletClient.writeContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "deposit",
    args: [token, amount, purpose, "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  return depositHash;
}
