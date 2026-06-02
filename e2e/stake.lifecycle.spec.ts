import { expect, test } from "@playwright/test";
import { parseEther, type Address } from "viem";
import { VAULT_ABI } from "../lib/contracts/abis";
import { ALICE, HS_TOKEN, USDT_TOKEN } from "./constants";
import {
  accountClient,
  advanceTime,
  apiRequest,
  apiStatus,
  bearer,
  depositToVault,
  fundStakeLifecycleAccount,
  getVaultAddress,
  latestBlockTimestamp,
  publicClient,
  resetE2eState,
  signIn,
} from "./helpers";

test.describe("stake lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  test("USDT 3-month order matures with synced Worker/anvil time and claims on Vault", async () => {
    const vault = getVaultAddress();
    await resetE2eState(await latestBlockTimestamp());
    await fundStakeLifecycleAccount(ALICE.address as Address, vault);

    const token = await signIn(ALICE);
    const amount = parseEther("100");
    const depositHash = await depositToVault(ALICE, USDT_TOKEN as Address, amount, 1);

    const created = await apiRequest<{ id: string; monthlyRateBps: number }>("/stake/orders", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ sourceTxHash: depositHash, asset: "USDT", amountWei: amount.toString(), lockMonths: 3 }),
    });
    expect(created.id).toBeTruthy();
    expect(created.monthlyRateBps).toBeGreaterThan(0);

    const beforeMaturity = await apiStatus("/stake/claim", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ orderId: created.id }),
    });
    expect(beforeMaturity.status).toBe(400);
    expect(beforeMaturity.body).toMatchObject({ error: "not matured" });

    await advanceTime(3 * 30 * 86400 + 1);

    const claim = await apiRequest<{
      token: Address;
      tokens?: Address[];
      recipients: Address[];
      amounts: string[];
      amount: string;
      nonce: string;
      deadline: number;
      reason: number;
      signature: `0x${string}`;
      claimableHs: string;
      fuelBurnHs: string;
    }>("/stake/claim", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ orderId: created.id }),
    });

    expect(claim.token.toLowerCase()).toBe(HS_TOKEN.toLowerCase());
    expect(BigInt(claim.amount)).toBeGreaterThan(0n);
    expect(claim.reason).toBe(1);

    const { walletClient } = accountClient(ALICE);
    const claimHash = await walletClient.writeContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "claim",
      args: [
        claim.tokens ?? claim.amounts.map(() => claim.token),
        claim.recipients,
        claim.amounts.map((amount) => BigInt(amount)),
        BigInt(claim.nonce),
        BigInt(claim.deadline),
        claim.reason,
        claim.signature,
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: claimHash });

    expect(BigInt(claim.claimableHs)).toBeGreaterThan(0n);
    expect(BigInt(claim.fuelBurnHs)).toBeGreaterThan(0n);

    const used = await publicClient.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "usedNonces",
      args: [BigInt(claim.nonce)],
    });
    expect(used).toBe(true);

  });
});
