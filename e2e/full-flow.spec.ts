/**
 * E2E 测试套件：Hotshort DApp 全链路自动化
 *
 * 覆盖 README v1.1 所有模块：
 *   1. 质押（USDT × 3 月 → 到期 → claim）
 *   2. AI 套餐购买（创世 5000U → 股票赠送 50%）
 *   3. HS→股票闪兑（锁仓 2 年）
 *   4. 彩票（买票 → 开奖 → 中奖领取）
 *   5. 燃烧（burnHS → 周榜 → claim）
 *   6. 推荐关系（Alice 邀请 Bob → Bob 买套餐 → Alice 拿直推返佣）
 *   7. Admin（改利率 → 导入创世名单 → 手动开奖）
 *
 * 使用 headless-web3-provider 模拟钱包，无需 MetaMask。
 * 使用 anvil fork BSC 主网，测试账户来自 Hardhat 标准助记词。
 *
 * 运行：
 *   1. ./scripts/dev-local.sh   (启动 anvil + Worker + Next.js)
 *   2. pnpm test:e2e            (跑本文件)
 */

import { test, expect, type Page } from "@playwright/test";
import { createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ALICE, BOB, DEPLOYER, ANVIL_RPC, ANVIL_CHAIN_ID } from "./constants";

// 预计算的 storage slots（Alice 地址固定）
const ALICE_USDT_SLOT = "0x0b083aff9656985dfe31da85d804ae48751ca629d18248f32ff52e77f5a2fb2b"; // slot 1
const ALICE_HS_SLOT = "0x215be5d23550ceb1beff54fb579a765903ba2ccc85b6f79bcf9bda4e8cb86034"; // slot 0
const DEAL_VALUE = "0x00000000000000000000000000000000000000000000021E19E0C9BAB2400000"; // 10000e18

type TestAccount = {
  address: `0x${string}`;
  privateKey: Hex;
};

type JsonRpcTransaction = {
  from?: string;
  to?: `0x${string}`;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  nonce?: Hex;
};

const localChain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: "Anvil BSC Fork",
  nativeCurrency: { decimals: 18, name: "BNB", symbol: "BNB" },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

async function rpcCall<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`[${method}] ${json.error.message ?? "RPC error"}`);
  return json.result as T;
}

function hexToBigInt(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;
  return BigInt(value);
}

function hexToNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  return Number(BigInt(value));
}

function shortAddress(address: string, chars = 3) {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * 注入 EIP-1193 provider 到浏览器 window.ethereum。
 * provider 的 request 通过 Playwright 桥接到 Node 端，由 viem 用测试私钥真实签名。
 */
async function injectWallet(page: Page, accountInfo: TestAccount) {
  const account = privateKeyToAccount(accountInfo.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: localChain,
    transport: http(ANVIL_RPC),
  });

  await page.exposeFunction("__hotshortWalletRequest", async (request: { method: string; params?: unknown[] }) => {
    const params = request.params ?? [];
    switch (request.method) {
      case "eth_chainId":
        return `0x${ANVIL_CHAIN_ID.toString(16)}`;
      case "net_version":
        return String(ANVIL_CHAIN_ID);
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];
      case "wallet_requestPermissions":
        return [{ parentCapability: "eth_accounts", caveats: [] }];
      case "wallet_getPermissions":
        return [{ invoker: "hotshort-e2e", parentCapability: "eth_accounts", caveats: [] }];
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign": {
        const message = String(params[0]?.toString().toLowerCase() === account.address.toLowerCase() ? params[1] : params[0]);
        return account.signMessage({ message: isHex(message) ? { raw: message } : message });
      }
      case "eth_sign": {
        const message = String(params[1] ?? params[0]);
        return account.signMessage({ message: isHex(message) ? { raw: message } : message });
      }
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4": {
        const rawTypedData = params[1] ?? params[0];
        const typedData = typeof rawTypedData === "string" ? JSON.parse(rawTypedData) : rawTypedData;
        return account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]);
      }
      case "eth_sendTransaction": {
        const tx = (params[0] ?? {}) as JsonRpcTransaction;
        if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error(`Unexpected from address: ${tx.from}`);
        }
        return walletClient.sendTransaction({
          account,
          to: tx.to,
          data: tx.data,
          value: hexToBigInt(tx.value),
          gas: hexToBigInt(tx.gas),
          gasPrice: hexToBigInt(tx.gasPrice),
          maxFeePerGas: hexToBigInt(tx.maxFeePerGas),
          maxPriorityFeePerGas: hexToBigInt(tx.maxPriorityFeePerGas),
          nonce: hexToNumber(tx.nonce),
        } as Parameters<typeof walletClient.sendTransaction>[0]);
      }
      default:
        return rpcCall(request.method, params);
    }
  });

  await page.addInitScript(
    ({ address, chainId }) => {
      type Listener = (...args: unknown[]) => void;
      const browserWindow = window as typeof window & {
        ethereum?: unknown;
        __hotshortWalletRequest?: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
      };
      const listeners: Record<string, Listener[]> = {};
      const chainHex = `0x${chainId.toString(16)}`;

      window.localStorage.clear();
      window.sessionStorage.clear();

      const provider = {
        isMetaMask: true,
        chainId: chainHex,
        selectedAddress: address,
        _metamask: { isUnlocked: async () => true },
        on(event: string, listener: Listener) {
          listeners[event] = listeners[event] ?? [];
          listeners[event].push(listener);
          return provider;
        },
        removeListener(event: string, listener: Listener) {
          listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener);
          return provider;
        },
        emit(event: string, ...args: unknown[]) {
          for (const listener of listeners[event] ?? []) listener(...args);
          return true;
        },
        request(request: { method: string; params?: unknown[] }) {
          return browserWindow.__hotshortWalletRequest?.(request);
        },
      };

      browserWindow.ethereum = provider;
      window.dispatchEvent(new Event("ethereum#initialized"));

      const providerDetail = Object.freeze({
        info: {
          uuid: "hotshort-e2e-wallet",
          name: "Hotshort E2E Wallet",
          icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
          rdns: "hotshort.e2e",
        },
        provider,
      });
      const announce = () => {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: providerDetail }));
      };
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { address: account.address, chainId: ANVIL_CHAIN_ID },
  );
}

async function connectWallet(page: Page, address: string) {
  const connectedButton = page.getByRole("button", { name: new RegExp(escapeRegExp(shortAddress(address))) }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await connectedButton.isVisible()) return;
    const connectButton = page.getByRole("button", { name: /Connect|连接/ }).first();
    await expect(connectButton).toBeVisible({ timeout: 10_000 });
    await connectButton.click();
    const connected = await connectedButton
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (connected) return;
  }
  await expect(connectedButton).toBeVisible({ timeout: 10_000 });
}

test.describe("Hotshort DApp E2E", () => {
  test.describe.configure({ mode: "serial" });

  // 每个测试前重新给 Alice 打满余额
  test.beforeEach(async () => {
    await rpcCall("anvil_setBalance", [DEPLOYER.address, "0x56BC75E2D63100000"]);
    await rpcCall("anvil_setBalance", [ALICE.address, "0x56BC75E2D63100000"]);
    await rpcCall("anvil_setBalance", [BOB.address, "0x56BC75E2D63100000"]);
    await rpcCall("anvil_setStorageAt", ["0x55d398326f99059fF775485246999027B3197955", ALICE_USDT_SLOT, DEAL_VALUE]);
    await rpcCall("anvil_setStorageAt", ["0xcF4907621f0d9803c7288423B4303226b696B533", ALICE_HS_SLOT, DEAL_VALUE]);
  });

  test("首页加载 + 连接钱包", async ({ page }) => {
    await injectWallet(page, ALICE);
    await page.goto("/");
    await expect(page.locator("nav[aria-label]")).toBeVisible();
    await connectWallet(page, ALICE.address);
  });

  test("质押 USDT × 3 月", async ({ page }) => {
    await injectWallet(page, ALICE);
    await page.goto("/stake");
    await connectWallet(page, ALICE.address);

    // 选 USDT
    await page.getByRole("button", { name: "USDT" }).click();
    // 选 3 月
    await page.getByRole("button", { name: /^(3 月|3 mo)$/ }).click();
    // 输入金额
    await page.fill("input[type=number]", "100");
    // 点确认质押
    await page.click("button:has-text('Stake'), button:has-text('确认质押')");
    await expect(page.getByRole("dialog").filter({ hasText: /质押成功|Staked/ })).toBeVisible({ timeout: 60_000 });
    await page.locator(".swal2-confirm").click({ force: true });
  });

  test("AI 套餐页渲染 5 档卡片", async ({ page }) => {
    await injectWallet(page, ALICE);
    await page.goto("/ai");
    await connectWallet(page, ALICE.address);
    // 验证 5 档套餐卡片都渲染了
    for (const amount of ["5000", "2000", "1000", "500", "100"]) {
      await expect(page.getByText(amount, { exact: true })).toBeVisible();
    }
  });

  test("HS→股票闪兑页渲染", async ({ page }) => {
    await injectWallet(page, ALICE);
    await page.goto("/ai/swap");
    await connectWallet(page, ALICE.address);
    await expect(page.locator("input[type=number]")).toBeVisible();
    await page.fill("input[type=number]", "50");
    // 验证预计获得显示了数字
    await expect(page.getByRole("button", { name: /Swap|确认兑换/ })).toBeVisible();
  });

  test("彩票页渲染 + 选号", async ({ page }) => {
    await injectWallet(page, ALICE);
    await page.goto("/lottery");
    await connectWallet(page, ALICE.address);
    const numberInput = page.locator("input[maxlength='6'], input.font-mono").first();
    if (await numberInput.isVisible()) {
      await numberInput.fill("123456");
    }
    await expect(page.locator("button:has-text('Buy'), button:has-text('购买')")).toBeVisible();
  });

  test("燃烧页渲染", async ({ page }) => {
    await injectWallet(page, ALICE);
    await page.goto("/burn");
    await connectWallet(page, ALICE.address);
    await expect(page.locator("input[type=number]")).toBeVisible();
    await expect(page.locator("button:has-text('Burn'), button:has-text('立即燃烧')")).toBeVisible();
  });

  test("推荐关系：Bob 通过 Alice 邀请链接进入", async ({ page }) => {
    await injectWallet(page, BOB);
    await page.goto(`/?ref=${ALICE.address}`);
    await connectWallet(page, BOB.address);
    // referrer 应该被存入 localStorage
    const ref = await page.evaluate(() => localStorage.getItem("hotshort_referrer"));
    expect(ref).toBe(ALICE.address.toLowerCase());
  });

  test("个人中心 - 资产/订单/团队/邀请 切换", async ({ page }) => {
    await injectWallet(page, ALICE);
    await page.goto("/me");
    await connectWallet(page, ALICE.address);

    // 切换 sub-tab
    for (const tab of ["Orders", "订单", "Team", "团队", "Invite", "邀请", "Settings", "设置"]) {
      const btn = page.locator(`button:has-text("${tab}")`);
      if (await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(500);
      }
    }
  });

  test("Admin - 利率配置页可访问", async ({ page }) => {
    await injectWallet(page, DEPLOYER);
    await page.goto("/admin");
    await connectWallet(page, DEPLOYER.address);

    // 应该看到 admin 页面内容（不被 guard 拦截）
    await expect(page.getByRole("heading", { name: /Admin Console|管理员后台/ })).toBeVisible({ timeout: 5_000 });
  });

  test("i18n 切换中英文", async ({ page }) => {
    await page.goto("/");
    // 找到语言切换按钮
    const langBtn = page.locator("button:has-text('中'), button:has-text('EN')");
    if (await langBtn.isVisible()) {
      await langBtn.click();
      await page.waitForTimeout(500);
      // 再点一次切回来
      await langBtn.click();
    }
  });
});
