import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 测试用常量：Hardhat 标准助记词派生的前 10 个账户。
 * 助记词：test test test test test test test test test test test junk
 *
 * 这些私钥仅用于本地 anvil 测试，绝不能用于任何真实链。
 */

export const TEST_MNEMONIC = "test test test test test test test test test test test junk";

export const ACCOUNTS = [
  {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    role: "deployer + owner + admin",
  },
  {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    role: "signer (Worker EIP-712)",
  },
  {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    role: "user-alice (质押/套餐/彩票/燃烧)",
  },
  {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    role: "user-bob (alice 的直推下级)",
  },
  {
    address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    privateKey: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    role: "user-charlie (bob 的直推下级，三代测试)",
  },
] as const;

export const DEPLOYER = ACCOUNTS[0];
export const SIGNER = ACCOUNTS[1];
export const ALICE = ACCOUNTS[2];
export const BOB = ACCOUNTS[3];
export const CHARLIE = ACCOUNTS[4];

export const ANVIL_RPC = "http://127.0.0.1:8545";
export const ANVIL_CHAIN_ID = 31337;

export const BSC_FORK_URL = "https://bsc-dataseed.binance.org";

function readDevVarAddress(key: string, fallback: `0x${string}`): `0x${string}` {
  const envValue = process.env[key];
  if (envValue?.match(/^0x[a-fA-F0-9]{40}$/)) return envValue as `0x${string}`;

  const devVarsPath = join(process.cwd(), "workers/.dev.vars");
  if (existsSync(devVarsPath)) {
    const match = readFileSync(devVarsPath, "utf8").match(new RegExp(`^${key}=(0x[a-fA-F0-9]{40})$`, "m"));
    if (match) return match[1] as `0x${string}`;
  }

  return fallback;
}

// 本地优先读取 scripts/dev-local.sh 写入的测试币地址；未启动本地环境时回退到旧 BSC fork 地址。
export const HS_TOKEN = readDevVarAddress("HS_TOKEN", "0xcf4907621f0d9803c7288423b4303226b696b533");
export const USDT_TOKEN = readDevVarAddress("USDT_TOKEN", "0x55d398326f99059ff775485246999027b3197955");
export const PANCAKE_PAIR = readDevVarAddress("PANCAKE_PAIR", "0x2398e858ac6ad9dea4496bc6ecacea4ce77cc67e");
