import { expect, test } from "@playwright/test";
import { parseEther, type Address } from "viem";
import { VAULT_ABI } from "../lib/contracts/abis";
import {
  BPS_DENOMINATOR,
  LOTTERY_PRIZE_BPS,
  LOTTERY_TO_POOL_BPS,
} from "../lib/constants/business-rules";
import { ALICE, BOB, CHARLIE, DEPLOYER, HS_TOKEN, PANCAKE_PAIR, USDT_TOKEN } from "./constants";
import {
  advanceTime,
  apiRequest,
  apiStatus,
  bearer,
  burnHsToVault,
  claimFromVault,
  depositToVault,
  fundLifecycleAccount,
  getVaultAddress,
  latestBlockTimestamp,
  publicClient,
  rpcCall,
  resetE2eState,
  runTestCron,
  setTestConfig,
  setTestLotteryWinning,
  signIn,
  transferToken,
  type VaultClaim,
} from "./helpers";

type TestAccount = Readonly<{
  address: `0x${string}`;
  privateKey: `0x${string}`;
  role: string;
}>;

type StakeOrderResponse = {
  id: string;
  monthlyRateBps: number;
};

type StakeClaimResponse = VaultClaim & {
  amount: string;
  principalToken: Address;
  principalAmount: string;
  claimableHs: string;
  fuelBurnHs: string;
};

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

function sumClaimPayout(claim: VaultClaim, token: Address, recipient?: Address): bigint {
  const expectedToken = token.toLowerCase();
  const expectedRecipient = recipient?.toLowerCase();
  return claim.amounts.reduce((total, amount, index) => {
    const payoutToken = (claim.tokens?.[index] ?? claim.token).toLowerCase();
    const payoutRecipient = claim.recipients[index]?.toLowerCase();
    if (payoutToken !== expectedToken) return total;
    if (expectedRecipient && payoutRecipient !== expectedRecipient) return total;
    return total + BigInt(amount);
  }, 0n);
}

type AiBuyResponse = {
  id: string;
  tier: string;
  usdtIn: string;
  stockGranted: string;
};

type AiOrderResponse = {
  id: string;
  stock_granted: string;
  released_stock: string;
  locked_stock: string;
  next_unlocks_at: number | null;
  releases: { release_index: number; stock_amount: string; unlocks_at: number; released_at: number | null }[];
};

type HoldingsResponse = {
  totalStock: string;
  lockedStock: string;
};

type LotteryRoundResponse = {
  current: {
    roundNo: number;
    poolHs: string;
    ticketPriceHs: string;
  };
  myTickets: {
    id: string;
    round_no: number;
    numbers: string;
    paid_hs: string;
    hit_digits: string | null;
    prize_hs: string | null;
    claimed: number;
  }[];
};

type BurnMeResponse = {
  totalBurnedHs: string;
  totalBurnedUsdt: string;
  personalCapUsdt: string;
  personalClaimedUsdt: string;
  personalClaimableUsdt: string;
  personalClaimed: boolean;
  out: boolean;
  burnPendingUsdt: string;
  pendingBreakdown?: {
    promotionUsdt: string;
    lpDividendUsdt?: string;
  };
  eligibleAirdrop: boolean;
};

type ReferralTreeResponse = {
  rewardsPending: {
    usdtWei: string;
    stockWei: string;
    hsWei: string;
    count: number;
  };
};

async function resetAndFund(accounts: TestAccount[]): Promise<Address> {
  const vault = getVaultAddress();
  await resetE2eState(await latestBlockTimestamp());
  for (const account of accounts) {
    await fundLifecycleAccount(account.address as Address, vault);
  }
  return vault;
}

async function expectNonceConsumed(claim: VaultClaim): Promise<void> {
  const used = await publicClient.readContract({
    address: getVaultAddress(),
    abi: VAULT_ABI,
    functionName: "usedNonces",
    args: [BigInt(claim.nonce)],
  });
  expect(used).toBe(true);
}

async function getReferralCode(jwt: string): Promise<string> {
  const result = await apiRequest<{ code: string }>("/referral/code", { headers: bearer(jwt) });
  expect(result.code).toMatch(/^[A-Z0-9]{4,12}$/);
  return result.code;
}

async function bindByReferralCode(jwt: string, referralCode: string): Promise<void> {
  const result = await apiRequest<{ ok: boolean; referrer: string }>("/referral/bind", {
    method: "POST",
    headers: bearer(jwt),
    body: JSON.stringify({ referralCode }),
  });
  expect(result.ok).toBe(true);
}

async function createStakeOrder(params: {
  account: TestAccount;
  token: Address;
  jwt: string;
  asset: "USDT" | "HS" | "LP";
  amount: bigint;
  lockMonths: 1 | 3 | 6 | 12;
}): Promise<StakeOrderResponse> {
  const sourceTxHash = await depositToVault(params.account, params.token, params.amount, 1);
  return apiRequest<StakeOrderResponse>("/stake/orders", {
    method: "POST",
    headers: bearer(params.jwt),
    body: JSON.stringify({
      sourceTxHash,
      asset: params.asset,
      amountWei: params.amount.toString(),
      lockMonths: params.lockMonths,
    }),
  });
}

async function buyAiPackage(params: {
  account: TestAccount;
  jwt: string;
  tier: "genesis" | "glory" | "eternal" | "shine" | "pioneer";
  usdt: bigint;
  referrer?: Address;
}): Promise<AiBuyResponse> {
  const sourceTxHash = await depositToVault(params.account, USDT_TOKEN as Address, params.usdt, 2);
  return apiRequest<AiBuyResponse>("/ai/buy", {
    method: "POST",
    headers: bearer(params.jwt),
    body: JSON.stringify({
      sourceTxHash,
      tier: params.tier,
      referrer: params.referrer,
    }),
  });
}

async function recordBurn(params: {
  account: TestAccount;
  jwt: string;
  amount: bigint;
  referrer?: Address;
}) {
  const sourceTxHash = await burnHsToVault(params.account, params.amount, params.referrer);
  return apiRequest<{ id: string; totalBurnedHs: string; totalBurnedUsdt: string; out: boolean }>("/burn/record", {
    method: "POST",
    headers: bearer(params.jwt),
    body: JSON.stringify({
      sourceTxHash,
      hsAmountWei: params.amount.toString(),
      referrer: params.referrer,
    }),
  });
}

test.describe("README rule lifecycle scripts", () => {
  test.describe.configure({ mode: "serial" });

  test("staking and admin rates cover snapshots, USDT/HS/LP maturity, and fuel burn payouts", async () => {
    await resetAndFund([ALICE, DEPLOYER]);
    const adminJwt = await signIn(DEPLOYER);
    const aliceJwt = await signIn(ALICE);
    await bindByReferralCode(aliceJwt, await getReferralCode(adminJwt));

    const ratePayload = {
      rates: [
        { asset: "USDT", lock_months: 1, monthly_rate_bps: 123 },
        { asset: "HS", lock_months: 6, monthly_rate_bps: 456 },
        { asset: "LP", lock_months: 12, monthly_rate_bps: 789 },
      ],
    };
    await apiRequest<{ updated: number }>("/admin/rates", {
      method: "POST",
      headers: bearer(adminJwt),
      body: JSON.stringify(ratePayload),
    });

    const oldUsdtOrder = await createStakeOrder({
      account: ALICE,
      token: USDT_TOKEN as Address,
      jwt: aliceJwt,
      asset: "USDT",
      amount: parseEther("100"),
      lockMonths: 1,
    });
    expect(oldUsdtOrder.monthlyRateBps).toBe(123);

    await apiRequest<{ updated: number }>("/admin/rates", {
      method: "POST",
      headers: bearer(adminJwt),
      body: JSON.stringify({ rates: [{ asset: "USDT", lock_months: 1, monthly_rate_bps: 321 }] }),
    });

    const newUsdtOrder = await createStakeOrder({
      account: ALICE,
      token: USDT_TOKEN as Address,
      jwt: aliceJwt,
      asset: "USDT",
      amount: parseEther("50"),
      lockMonths: 1,
    });
    const hsOrder = await createStakeOrder({
      account: ALICE,
      token: HS_TOKEN as Address,
      jwt: aliceJwt,
      asset: "HS",
      amount: parseEther("10000"),
      lockMonths: 6,
    });
    const lpOrder = await createStakeOrder({
      account: ALICE,
      token: PANCAKE_PAIR as Address,
      jwt: aliceJwt,
      asset: "LP",
      amount: parseEther("1"),
      lockMonths: 12,
    });
    expect(newUsdtOrder.monthlyRateBps).toBe(321);
    expect(hsOrder.monthlyRateBps).toBe(456);
    expect(lpOrder.monthlyRateBps).toBe(789);

    const listed = await apiRequest<{ orders: { id: string; monthly_rate_bps: number }[] }>("/stake/orders", {
      headers: bearer(aliceJwt),
    });
    const oldSnapshot = listed.orders.find((order) => order.id === oldUsdtOrder.id);
    expect(oldSnapshot?.monthly_rate_bps).toBe(123);

    const prematureClaim = await apiStatus("/stake/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({ orderId: lpOrder.id }),
    });
    expect(prematureClaim.status).toBe(400);
    expect(prematureClaim.body).toMatchObject({ error: "not matured" });

    await advanceTime(12 * 30 * 86400 + 1);

    const stakeClaims = [
      { orderId: oldUsdtOrder.id, principalToken: USDT_TOKEN as Address },
      { orderId: newUsdtOrder.id, principalToken: USDT_TOKEN as Address },
      { orderId: hsOrder.id, principalToken: HS_TOKEN as Address },
      { orderId: lpOrder.id, principalToken: PANCAKE_PAIR as Address },
    ];
    for (const { orderId, principalToken } of stakeClaims) {
      const claim = await apiRequest<StakeClaimResponse>("/stake/claim", {
        method: "POST",
        headers: bearer(aliceJwt),
        body: JSON.stringify({ orderId }),
      });
      expect(claim.principalToken.toLowerCase()).toBe(principalToken.toLowerCase());
      expect(claim.reason).toBe(1);
      expect(BigInt(claim.claimableHs)).toBeGreaterThan(0n);
      expect(BigInt(claim.fuelBurnHs)).toBeGreaterThan(0n);
      const expectedAliceHs = BigInt(claim.claimableHs) + (principalToken.toLowerCase() === HS_TOKEN.toLowerCase() ? BigInt(claim.principalAmount) : 0n);
      expect(sumClaimPayout(claim, principalToken, ALICE.address as Address)).toBeGreaterThanOrEqual(BigInt(claim.principalAmount));
      expect(sumClaimPayout(claim, HS_TOKEN as Address, ALICE.address as Address)).toBe(expectedAliceHs);
      expect(sumClaimPayout(claim, HS_TOKEN as Address, DEAD_ADDRESS)).toBe(BigInt(claim.fuelBurnHs));
      expect(claim.recipients.some((recipient) => recipient.toLowerCase().endsWith("dead"))).toBe(true);
      await claimFromVault(ALICE, claim);
      await expectNonceConsumed(claim);
    }
  });

  test("LP dividend only accepts trusted-wallet USDT transfers and distributes them once", async () => {
    const vault = await resetAndFund([ALICE, BOB, DEPLOYER]);
    const adminJwt = await signIn(DEPLOYER);
    const aliceJwt = await signIn(ALICE);
    const bobJwt = await signIn(BOB);

    const rootCode = await getReferralCode(adminJwt);
    await bindByReferralCode(aliceJwt, rootCode);
    await bindByReferralCode(bobJwt, rootCode);
    await recordBurn({ account: ALICE, jwt: aliceJwt, amount: parseEther("1000") });
    await recordBurn({ account: BOB, jwt: bobJwt, amount: parseEther("1000") });

    // 忽略测试账户初始化产生的旧转账，只观察下方两笔新交易。
    await setTestConfig("indexer_last_block", (await publicClient.getBlockNumber()).toString());
    await transferToken(ALICE, USDT_TOKEN as Address, vault, parseEther("20"));
    const trustedAmount = parseEther("125");
    const trustedTxHash = await transferToken(DEPLOYER, USDT_TOKEN as Address, vault, trustedAmount);

    const indexed = await runTestCron<{ from: string; to: string; count: number }>("indexer");
    expect(indexed.result.count).toBeGreaterThan(0);

    type LpAdminResponse = {
      sourceAddress: string;
      pendingUsdtWei: string;
      recentReceipts: {
        tx_hash: string;
        log_index: number;
        amount_usdt: string;
        settled_round: number | null;
      }[];
    };
    const beforeDistribution = await apiRequest<LpAdminResponse>("/admin/lp-dividend", {
      headers: bearer(adminJwt),
    });
    expect(beforeDistribution.sourceAddress).toBe(DEPLOYER.address.toLowerCase());
    expect(beforeDistribution.pendingUsdtWei).toBe(trustedAmount.toString());
    expect(beforeDistribution.recentReceipts).toHaveLength(1);
    expect(beforeDistribution.recentReceipts[0]).toMatchObject({
      tx_hash: trustedTxHash,
      amount_usdt: trustedAmount.toString(),
      settled_round: null,
    });

    // 多挖一个空块后会重扫上一游标块；同一日志仍不会重复入账。
    await rpcCall("evm_mine");
    await runTestCron("indexer");
    const afterReplay = await apiRequest<LpAdminResponse>("/admin/lp-dividend", { headers: bearer(adminJwt) });
    expect(afterReplay.pendingUsdtWei).toBe(trustedAmount.toString());
    expect(afterReplay.recentReceipts).toHaveLength(1);

    const distributed = await runTestCron<{
      round: number;
      amountUsdt: string;
      recipients: number;
      skipped: boolean;
      pendingUsdt: string;
    }>("lp-dividend");
    expect(distributed.result).toMatchObject({
      round: 1,
      amountUsdt: trustedAmount.toString(),
      recipients: 4,
      skipped: false,
      pendingUsdt: "0",
    });

    const expectedPerUser = trustedAmount / 2n;
    const aliceBurn = await apiRequest<BurnMeResponse>("/burn/me", { headers: bearer(aliceJwt) });
    const bobBurn = await apiRequest<BurnMeResponse>("/burn/me", { headers: bearer(bobJwt) });
    expect(BigInt(aliceBurn.pendingBreakdown?.lpDividendUsdt ?? "0")).toBe(expectedPerUser);
    expect(BigInt(bobBurn.pendingBreakdown?.lpDividendUsdt ?? "0")).toBe(expectedPerUser);

    const noReplay = await runTestCron<{ skipped: boolean; pendingUsdt: string }>("lp-dividend");
    expect(noReplay.result).toMatchObject({ skipped: true, pendingUsdt: "0" });
  });

  test("AI package, referral, daily dividend, HS airdrop, and HS-to-stock swap lifecycle", async () => {
    await resetAndFund([ALICE, BOB, CHARLIE, DEPLOYER]);
    const adminJwt = await signIn(DEPLOYER);
    const aliceJwt = await signIn(ALICE);
    const bobJwt = await signIn(BOB);
    const charlieJwt = await signIn(CHARLIE);

    const rootCode = await getReferralCode(adminJwt);
    const resolvedRoot = await apiRequest<{ referrer: string }>(`/referral/resolve/${rootCode}`);
    expect(resolvedRoot.referrer).toBe(DEPLOYER.address.toLowerCase());
    await bindByReferralCode(aliceJwt, rootCode);
    const aliceCode = await getReferralCode(aliceJwt);
    await bindByReferralCode(bobJwt, aliceCode);
    const bobCode = await getReferralCode(bobJwt);
    await bindByReferralCode(charlieJwt, bobCode);

    await apiRequest("/admin/stock-price", {
      method: "POST",
      headers: bearer(adminJwt),
      body: JSON.stringify({ priceUsdt: 1 }),
    });
    await apiRequest("/admin/ai-config", {
      method: "POST",
      headers: bearer(adminJwt),
      body: JSON.stringify({ volumeMin: 100000, volumeMax: 100000, ratioBps: 100 }),
    });

    const aliceBuy = await buyAiPackage({ account: ALICE, jwt: aliceJwt, tier: "genesis", usdt: parseEther("5000") });
    const bobBuy = await buyAiPackage({
      account: BOB,
      jwt: bobJwt,
      tier: "glory",
      usdt: parseEther("2000"),
      referrer: ALICE.address as Address,
    });
    const charlieBuy = await buyAiPackage({
      account: CHARLIE,
      jwt: charlieJwt,
      tier: "eternal",
      usdt: parseEther("1000"),
      referrer: BOB.address as Address,
    });
    expect(BigInt(aliceBuy.stockGranted)).toBe(parseEther("2500"));
    expect(BigInt(bobBuy.stockGranted)).toBe(parseEther("400"));
    expect(BigInt(charlieBuy.stockGranted)).toBe(parseEther("100"));

    const aliceOrdersAfterBuy = await apiRequest<{ orders: AiOrderResponse[] }>("/ai/orders", { headers: bearer(aliceJwt) });
    const alicePackageOrder = aliceOrdersAfterBuy.orders.find((order) => order.id === aliceBuy.id);
    expect(alicePackageOrder?.releases).toHaveLength(8);
    expect(BigInt(alicePackageOrder?.locked_stock ?? "0")).toBe(parseEther("2500"));
    expect(BigInt(alicePackageOrder?.released_stock ?? "0")).toBe(0n);

    const beforePackageRelease = await apiRequest<HoldingsResponse>("/ai/holdings", { headers: bearer(aliceJwt) });
    await advanceTime(3 * 30 * 86400 + 1);
    const releaseCron = await runTestCron<{ releasedRows: number; releasedStock: string }>("ai-release");
    expect(releaseCron.result.releasedRows).toBe(3);
    expect(BigInt(releaseCron.result.releasedStock)).toBe(parseEther("300"));
    const afterPackageRelease = await apiRequest<HoldingsResponse>("/ai/holdings", { headers: bearer(aliceJwt) });
    expect(BigInt(beforePackageRelease.lockedStock) - BigInt(afterPackageRelease.lockedStock)).toBe(parseEther("250"));

    const aliceOrdersAfterRelease = await apiRequest<{ orders: AiOrderResponse[] }>("/ai/orders", { headers: bearer(aliceJwt) });
    const releasedPackageOrder = aliceOrdersAfterRelease.orders.find((order) => order.id === aliceBuy.id);
    expect(BigInt(releasedPackageOrder?.released_stock ?? "0")).toBe(parseEther("250"));
    expect(releasedPackageOrder?.releases[0]?.released_at).toBeTruthy();
    expect(releasedPackageOrder?.next_unlocks_at).toBeGreaterThan(releasedPackageOrder?.releases[0]?.unlocks_at ?? 0);

    const referralTree = await apiRequest<{ counts: { gen1: number; gen2: number; gen3: number } }>("/referral/tree", {
      headers: bearer(aliceJwt),
    });
    expect(referralTree.counts).toMatchObject({ gen1: 1, gen2: 1, gen3: 0 });

    const directReferralClaim = await apiRequest<VaultClaim & { amount: string; rows: number }>("/ai/referral/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
    });
    expect(directReferralClaim.reason).toBe(5);
    expect(directReferralClaim.rows).toBeGreaterThan(0);
    expect(BigInt(directReferralClaim.amount)).toBe(parseEther("120"));
    await claimFromVault(ALICE, directReferralClaim);
    await expectNonceConsumed(directReferralClaim);

    const dividendCron = await runTestCron<{ date: string; totalStock: string; recipients: number }>("ai-dividend");
    expect(dividendCron.result.recipients).toBe(3);
    expect(BigInt(dividendCron.result.totalStock)).toBe(parseEther("1000"));

    const aliceDividend = await apiRequest<{ dividend: { stock_share: string; claimed: number } }>("/ai/dividend/today", {
      headers: bearer(aliceJwt),
    });
    expect(BigInt(aliceDividend.dividend.stock_share)).toBeGreaterThan(0n);

    const aliceHoldingsBeforeDividend = await apiRequest<HoldingsResponse>("/ai/holdings", { headers: bearer(aliceJwt) });
    const stockDividendClaim = await apiRequest<{
      token: string;
      amount: string;
      divs: number;
      refs: number;
      burnStockRewards: number;
    }>("/ai/dividend/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
    });
    expect(stockDividendClaim.token).toBe("STOCK");
    expect(stockDividendClaim.divs).toBe(1);
    expect(stockDividendClaim.refs).toBeGreaterThan(0);
    expect(BigInt(stockDividendClaim.amount)).toBeGreaterThan(0n);
    const aliceHoldingsAfterDividend = await apiRequest<HoldingsResponse>("/ai/holdings", { headers: bearer(aliceJwt) });
    expect(BigInt(aliceHoldingsAfterDividend.totalStock)).toBeGreaterThan(BigInt(aliceHoldingsBeforeDividend.totalStock));

    const hsAirdrop = await apiRequest<VaultClaim & { amount: string; rows: number }>("/ai/airdrop/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
    });
    expect(hsAirdrop.reason).toBe(6);
    expect(hsAirdrop.rows).toBeGreaterThan(0);
    expect(BigInt(hsAirdrop.amount)).toBeGreaterThan(0n);
    await claimFromVault(ALICE, hsAirdrop);
    await expectNonceConsumed(hsAirdrop);

    const duplicateAirdrop = await apiRequest<{ token: null; amount: string; note: string }>("/ai/airdrop/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
    });
    expect(duplicateAirdrop).toMatchObject({ token: null, amount: "0" });

    const beforeSwapTime = await apiRequest<{ nowSeconds: number }>("/__test/time");
    const beforeSwapHoldings = await apiRequest<HoldingsResponse>("/ai/holdings", { headers: bearer(aliceJwt) });
    const hsQuote = await apiRequest<{ priceUsdt: number }>("/oracle/hs-price");
    const stockQuote = await apiRequest<{ priceUsdt: number }>("/oracle/stock-price");
    const swapAmount = parseEther("1000");
    const expectedSwapStockGross = (swapAmount * BigInt(Math.floor((hsQuote.priceUsdt / stockQuote.priceUsdt) * 1e18))) / parseEther("1");
    // FXHO 买入 3% 手续费（STOCK_TRADE_FEE_BPS = 300）
    const expectedSwapStockFee = (expectedSwapStockGross * 300n) / 10000n;
    const expectedSwapStock = expectedSwapStockGross - expectedSwapStockFee;
    const swapTxHash = await depositToVault(ALICE, HS_TOKEN as Address, swapAmount, 5);
    const swap = await apiRequest<{ id: string; stockOut: string; stockFee: string; stockLocked: string; unlocksAt: null }>("/ai/swap", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({ sourceTxHash: swapTxHash, hsAmountWei: swapAmount.toString() }),
    });
    expect(beforeSwapTime.nowSeconds).toBeGreaterThan(0);
    expect(BigInt(swap.stockOut)).toBe(expectedSwapStock);
    expect(BigInt(swap.stockFee)).toBe(expectedSwapStockFee);
    expect(BigInt(swap.stockLocked)).toBe(0n);
    expect(swap.unlocksAt).toBeNull();
    const afterSwapHoldings = await apiRequest<HoldingsResponse>("/ai/holdings", { headers: bearer(aliceJwt) });
    expect(BigInt(afterSwapHoldings.totalStock) - BigInt(beforeSwapHoldings.totalStock)).toBe(expectedSwapStock);
    expect(BigInt(afterSwapHoldings.lockedStock) - BigInt(beforeSwapHoldings.lockedStock)).toBe(0n);
  });

  test("stock market calendar closes swaps and daily dividend settlement", async () => {
    await resetAndFund([ALICE, DEPLOYER]);
    const adminJwt = await signIn(DEPLOYER);
    const aliceJwt = await signIn(ALICE);

    await apiRequest("/__test/time/set", {
      method: "POST",
      body: JSON.stringify({ nowSeconds: Math.floor(Date.UTC(2026, 5, 27, 1, 0, 0) / 1000) }),
    });
    await apiRequest("/admin/stock-trade", {
      method: "POST",
      headers: bearer(adminJwt),
      body: JSON.stringify({ mode: "auto" }),
    });

    const weekendQuote = await apiRequest<{ tradePaused: boolean; marketClosed: boolean; marketClosedReason: string }>("/oracle/stock-price");
    expect(weekendQuote).toMatchObject({ tradePaused: true, marketClosed: true, marketClosedReason: "weekend" });

    const blockedSwap = await apiStatus("/ai/swap", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({}),
    });
    expect(blockedSwap.status).toBe(403);
    expect(blockedSwap.body).toMatchObject({ error: "stock trade paused", marketClosedReason: "weekend" });

    const skippedDividend = await runTestCron<null>("ai-dividend");
    expect(skippedDividend.result).toBeNull();

    await apiRequest("/admin/stock-trade", {
      method: "POST",
      headers: bearer(adminJwt),
      body: JSON.stringify({ mode: "manual", manualClosed: false }),
    });
    const manualOpenQuote = await apiRequest<{ tradePaused: boolean; marketClosed: boolean; marketMode: string }>("/oracle/stock-price");
    expect(manualOpenQuote).toMatchObject({ tradePaused: false, marketClosed: false, marketMode: "manual" });

    const openDividend = await runTestCron<{ date: string; totalStock: string; recipients: number }>("ai-dividend");
    expect(openDividend.result.date).toBe("2026-06-27");
    expect(BigInt(openDividend.result.totalStock)).toBeGreaterThan(0n);
  });

  test("lottery lifecycle covers buy, pending pancake sync, draw settlement, prize claim, and duplicate guard", async () => {
    await resetAndFund([ALICE, DEPLOYER]);
    const adminJwt = await signIn(DEPLOYER);
    const aliceJwt = await signIn(ALICE);
    await bindByReferralCode(aliceJwt, await getReferralCode(adminJwt));

    const initialRound = await apiRequest<LotteryRoundResponse>("/lottery/round", { headers: bearer(aliceJwt) });
    await setTestLotteryWinning(null);
    const pendingDraw = await runTestCron<{ pending?: boolean; reason?: string }>("lottery");
    expect(pendingDraw.result).toMatchObject({ pending: true, reason: "pancake result unavailable" });

    const ticketPrice = BigInt(initialRound.current.ticketPriceHs);
    const ticketTxHash = await depositToVault(ALICE, HS_TOKEN as Address, ticketPrice * 2n, 3);
    const bought = await apiRequest<{ roundNo: number; count: number; entries: string[]; paidHs: string; poolAdditionHs: string }>("/lottery/buy", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({ sourceTxHash: ticketTxHash, entries: ["123456", "654321"] }),
    });
    expect(bought.roundNo).toBe(initialRound.current.roundNo);
    expect(bought.count).toBe(2);
    expect(bought.entries).toEqual(["123456", "654321"]);
    expect(BigInt(bought.poolAdditionHs)).toBe((ticketPrice * 2n * BigInt(LOTTERY_TO_POOL_BPS)) / BigInt(BPS_DENOMINATOR));

    await setTestLotteryWinning("123456");
    const draw = await runTestCron<{ roundNo: number; winning: string; settledTickets: number }>("lottery");
    expect(draw.result).toMatchObject({ roundNo: initialRound.current.roundNo, winning: "123456", settledTickets: 1 });

    const settledRound = await apiRequest<LotteryRoundResponse>("/lottery/round", { headers: bearer(aliceJwt) });
    const settledTicket = settledRound.myTickets.find((ticket) => ticket.numbers === "123456");
    expect(settledTicket).toBeTruthy();
    const poolAfterBuy = BigInt(initialRound.current.poolHs) + BigInt(bought.poolAdditionHs);
    const expectedPrize = (poolAfterBuy * BigInt(LOTTERY_PRIZE_BPS.hit6All)) / BigInt(BPS_DENOMINATOR);
    expect(BigInt(settledTicket!.prize_hs ?? "0")).toBe(expectedPrize);

    const prizeClaim = await apiRequest<VaultClaim & { amount: string }>("/lottery/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({ ticketId: settledTicket!.id }),
    });
    expect(prizeClaim.reason).toBe(3);
    expect(BigInt(prizeClaim.amount)).toBe(expectedPrize);
    await claimFromVault(ALICE, prizeClaim);
    await expectNonceConsumed(prizeClaim);

    const duplicateClaim = await apiStatus("/lottery/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({ ticketId: settledTicket!.id }),
    });
    expect(duplicateClaim.status).toBe(400);
    expect(duplicateClaim.body).toMatchObject({ error: "already claimed" });
  });

  test("burn lifecycle covers leaderboard, weekly allocation, claims, double-out, AI/stake side rewards, and admin airdrop review", async () => {
    await resetAndFund([ALICE, BOB, CHARLIE, DEPLOYER]);
    const burnRound = Math.floor(Date.now() / 1000);
    await setTestConfig("burn_current_round", String(burnRound));
    const adminJwt = await signIn(DEPLOYER);
    const aliceJwt = await signIn(ALICE);
    const bobJwt = await signIn(BOB);
    const charlieJwt = await signIn(CHARLIE);

    const rootCode = await getReferralCode(adminJwt);
    await bindByReferralCode(aliceJwt, rootCode);
    const aliceCode = await getReferralCode(aliceJwt);
    await bindByReferralCode(bobJwt, aliceCode);
    const bobCode = await getReferralCode(bobJwt);
    await bindByReferralCode(charlieJwt, bobCode);

    await buyAiPackage({ account: ALICE, jwt: aliceJwt, tier: "genesis", usdt: parseEther("5000") });
    await createStakeOrder({
      account: CHARLIE,
      token: USDT_TOKEN as Address,
      jwt: charlieJwt,
      asset: "USDT",
      amount: parseEther("100"),
      lockMonths: 6,
    });

    const aliceBurn = await recordBurn({ account: ALICE, jwt: aliceJwt, amount: parseEther("1500000") });
    const bobBurn = await recordBurn({ account: BOB, jwt: bobJwt, amount: parseEther("2000"), referrer: ALICE.address as Address });
    const charlieBurn = await recordBurn({ account: CHARLIE, jwt: charlieJwt, amount: parseEther("1000"), referrer: BOB.address as Address });
    const expectedBurnRoundUsdt = BigInt(aliceBurn.totalBurnedUsdt) + BigInt(bobBurn.totalBurnedUsdt) + BigInt(charlieBurn.totalBurnedUsdt);

    const leaderboard = await apiRequest<{ rows: { user: string; burn_hs: string }[] }>("/burn/leaderboard");
    expect(leaderboard.rows.map((row) => row.user)).toEqual([
      ALICE.address.toLowerCase(),
      BOB.address.toLowerCase(),
      CHARLIE.address.toLowerCase(),
    ]);

    const settlement = await runTestCron<{ round: number; total: string; top10: number }>("burn-weekly");
    expect(settlement.result).toMatchObject({ round: burnRound, total: expectedBurnRoundUsdt.toString(), top10: 3 });

    const aliceBurnStatus = await apiRequest<BurnMeResponse>("/burn/me", { headers: bearer(aliceJwt) });
    const expectedAlicePersonalUsdt = BigInt(aliceBurnStatus.totalBurnedUsdt) * 2n;
    expect(aliceBurnStatus.eligibleAirdrop).toBe(true);
    expect(BigInt(aliceBurnStatus.totalBurnedUsdt)).toBeGreaterThanOrEqual(parseEther("1000"));
    expect(BigInt(aliceBurnStatus.burnPendingUsdt)).toBeGreaterThan(0n);
    expect(aliceBurnStatus.personalClaimed).toBe(false);
    expect(aliceBurnStatus.out).toBe(false);
    expect(BigInt(aliceBurnStatus.personalCapUsdt)).toBe(expectedAlicePersonalUsdt);
    const alicePersonalClaimableUsdt = BigInt(aliceBurnStatus.personalClaimableUsdt);
    expect(alicePersonalClaimableUsdt).toBeGreaterThan(0n);
    expect(alicePersonalClaimableUsdt).toBeLessThanOrEqual(expectedAlicePersonalUsdt);
    expect(BigInt(aliceBurnStatus.pendingBreakdown?.promotionUsdt ?? "0")).toBe(0n);
    const aliceReferralBeforePersonal = await apiRequest<ReferralTreeResponse>("/referral/tree", { headers: bearer(aliceJwt) });
    const aliceBurnInviteUsdt = BigInt(aliceReferralBeforePersonal.rewardsPending.usdtWei);
    expect(aliceBurnInviteUsdt).toBeGreaterThan(0n);

    const aliceStockRewardClaim = await apiRequest<{
      token: string;
      amount: string;
      divs: number;
      refs: number;
      burnStockRewards: number;
    }>("/ai/dividend/claim", {
      method: "POST",
      headers: bearer(aliceJwt),
    });
    expect(aliceStockRewardClaim.token).toBe("STOCK");
    expect(aliceStockRewardClaim.burnStockRewards).toBeGreaterThan(0);
    expect(BigInt(aliceStockRewardClaim.amount)).toBeGreaterThan(0n);

    const blockedActiveBurnClaim = await apiStatus("/burn/claim/top10", {
      method: "POST",
      headers: bearer(aliceJwt),
    });
    expect(blockedActiveBurnClaim.status).toBe(400);
    expect(blockedActiveBurnClaim.body).toMatchObject({ amount: "0", error: "claim personal burn dividends first" });

    const alicePersonalClaim = await apiRequest<VaultClaim & { amount: string; personalClaimedUsdt: string }>("/burn/claim/personal", {
      method: "POST",
      headers: bearer(aliceJwt),
    });
    expect(alicePersonalClaim.reason).toBe(8);
    expect(alicePersonalClaim.token.toLowerCase()).toBe(USDT_TOKEN.toLowerCase());
    expect(BigInt(alicePersonalClaim.amount)).toBe(alicePersonalClaimableUsdt);
    expect(BigInt(alicePersonalClaim.personalClaimedUsdt)).toBe(alicePersonalClaimableUsdt);
    const alicePersonalClaimTx = await claimFromVault(ALICE, alicePersonalClaim);
    await expectNonceConsumed(alicePersonalClaim);
    await apiRequest("/burn/claim/personal/confirm", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({ txHash: alicePersonalClaimTx, nonce: alicePersonalClaim.nonce }),
    });

    const aliceAfterPersonalClaimAttempt = await apiRequest<BurnMeResponse>("/burn/me", { headers: bearer(aliceJwt) });
    expect(aliceAfterPersonalClaimAttempt.personalClaimed).toBe(true);
    expect(aliceAfterPersonalClaimAttempt.out).toBe(true);
    expect(BigInt(aliceAfterPersonalClaimAttempt.personalCapUsdt)).toBe(expectedAlicePersonalUsdt);
    expect(BigInt(aliceAfterPersonalClaimAttempt.personalClaimableUsdt)).toBe(0n);
    expect(BigInt(aliceAfterPersonalClaimAttempt.personalClaimedUsdt)).toBe(alicePersonalClaimableUsdt);
    expect(BigInt(aliceAfterPersonalClaimAttempt.burnPendingUsdt)).toBeGreaterThan(0n);
    const aliceReferralAfterPersonal = await apiRequest<ReferralTreeResponse>("/referral/tree", { headers: bearer(aliceJwt) });
    expect(BigInt(aliceReferralAfterPersonal.rewardsPending.usdtWei)).toBe(aliceBurnInviteUsdt);

    const charlieActiveBurnClaim = await apiStatus("/burn/claim/top10", {
      method: "POST",
      headers: bearer(charlieJwt),
    });
    expect(charlieActiveBurnClaim.status).toBe(400);
    expect(charlieActiveBurnClaim.body).toMatchObject({ amount: "0", error: "claim personal burn dividends first" });

    const airdropSubmission = await apiRequest<{ id: string; created: boolean }>("/burn/airdrop/submit", {
      method: "POST",
      headers: bearer(aliceJwt),
      body: JSON.stringify({ hotshortAccount: "alice-hotshort" }),
    });
    expect(airdropSubmission.created).toBe(true);

    const airdropList = await apiRequest<{ items: { id: string; status: string; hotshort_account: string }[] }>("/admin/airdrop-list", {
      headers: bearer(adminJwt),
    });
    expect(airdropList.items.some((item) => item.id === airdropSubmission.id && item.status === "pending")).toBe(true);

    await apiRequest("/admin/airdrop-list", {
      method: "POST",
      headers: bearer(adminJwt),
      body: JSON.stringify({ id: airdropSubmission.id, status: "sent" }),
    });
    const reviewedAirdropList = await apiRequest<{ items: { id: string; status: string }[] }>("/admin/airdrop-list", {
      headers: bearer(adminJwt),
    });
    expect(reviewedAirdropList.items.find((item) => item.id === airdropSubmission.id)?.status).toBe("sent");
  });
});
