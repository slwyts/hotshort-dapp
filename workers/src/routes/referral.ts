import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { ensureReferralCode, resolveReferralCode, upsertUser, resolveReferrer } from "../lib/users";
import { readVaultOwner } from "../lib/vault-owner";

export const referral = new Hono<{ Bindings: Env }>();

interface RefRow {
  address: string;
  joined_at: number;
}

interface TreeRow {
  user: string;
  level1: string | null;
  level2: string | null;
  level3: string | null;
}

interface RewardRow {
  reward_token: string;
  reward_amount: string;
  claimed: number;
}

function emptyRewardTotals() {
  return { usdtWei: 0n, stockWei: 0n, hsWei: 0n, count: 0 };
}

function serializeRewardTotals(totals: ReturnType<typeof emptyRewardTotals>) {
  return {
    usdtWei: totals.usdtWei.toString(),
    stockWei: totals.stockWei.toString(),
    hsWei: totals.hsWei.toString(),
    count: totals.count,
  };
}

function addReward(totals: ReturnType<typeof emptyRewardTotals>, row: RewardRow): void {
  const amount = BigInt(row.reward_amount);
  if (row.reward_token === "USDT") totals.usdtWei += amount;
  else if (row.reward_token === "STOCK") totals.stockWei += amount;
  else if (row.reward_token === "HS") totals.hsWei += amount;
  totals.count += 1;
}

/**
 * GET /referral/tree
 * 当前用户作为上级时，三代下线列表 + 各代人数 + 累计/待领返佣。
 */
referral.get("/tree", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  // 三代下线（rebuilt referral_paths：用户 X 的 levelN 是其 N 代上级）
  const downstream = await c.env.DB.prepare(
    `SELECT user, level1, level2, level3 FROM referral_paths
     WHERE level1 = ? OR level2 = ? OR level3 = ?`,
  )
    .bind(user, user, user)
    .all<TreeRow>();

  const gen1: string[] = [];
  const gen2: string[] = [];
  const gen3: string[] = [];
  for (const r of downstream.results ?? []) {
    if (r.level1 === user) gen1.push(r.user);
    else if (r.level2 === user) gen2.push(r.user);
    else if (r.level3 === user) gen3.push(r.user);
  }

  const rewards = await c.env.DB.prepare(
    "SELECT reward_token, reward_amount, claimed FROM referral_rewards WHERE user = ?",
  )
    .bind(user)
    .all<RewardRow>();
  const rewardsTotal = emptyRewardTotals();
  const rewardsPending = emptyRewardTotals();
  for (const row of rewards.results ?? []) {
    addReward(rewardsTotal, row);
    if (!row.claimed) addReward(rewardsPending, row);
  }

  return c.json({
    counts: { gen1: gen1.length, gen2: gen2.length, gen3: gen3.length },
    members: { gen1, gen2, gen3 },
    rewardsTotal: serializeRewardTotals(rewardsTotal),
    rewardsPending: serializeRewardTotals(rewardsPending),
  });
});

/** GET /referral/owner  平台默认邀请人（Vault owner，链上读，60s 缓存） */
referral.get("/owner", async (c) => {
  const owner = await readVaultOwner(c.env);
  return c.json({ owner });
});

/** GET /referral/me  自己绑定的上级 */
referral.get("/me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const me = await c.env.DB.prepare(
    "SELECT level1, level2, level3 FROM referral_paths WHERE user = ?",
  )
    .bind(user)
    .first<{ level1: string | null; level2: string | null; level3: string | null }>();
  const u = await c.env.DB.prepare("SELECT referrer FROM users WHERE address = ?").bind(user).first<{ referrer: string | null }>();
  return c.json({
    referrer: u?.referrer ?? null,
    ancestors: me ?? { level1: null, level2: null, level3: null },
  });
});

/** GET /referral/code  获取当前用户短邀请码 */
referral.get("/code", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  await upsertUser(c.env, user);
  const code = await ensureReferralCode(c.env, user);
  return c.json({ code });
});

/** GET /referral/resolve/:code  解析短邀请码，前端用于展示确认 */
referral.get("/resolve/:code", async (c) => {
  const referrer = await resolveReferralCode(c.env, c.req.param("code"));
  if (!referrer) return c.json({ error: "invalid referral code" }, 404);
  return c.json({ referrer });
});

/**
 * POST /referral/bind  { referrer }
 * 用户登录后手动绑定上级。规则：
 *   - referrer 必须是合法地址，且不能等于自己
 *   - 一旦绑定成功，不能再修改（防止洗榜）
 *   - 不允许形成环（referrer 的祖先链中不能出现自己）
 *   - referrer 自己必须已绑定上级（保证链条连通到根）；
 *     例外：平台 Vault owner 作为根节点，无需绑定上级也可被引用
 *   - 调用方 = 平台 Vault owner 时绕开链条连通性 / 环检测，
 *     只校验地址合法 + 非自身 + 未绑定（owner 是孤立根，没有上级链可校验）
 */
referral.post("/bind", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { referrer?: string; referralCode?: string };
  const fromCode = body.referralCode ? await resolveReferralCode(c.env, body.referralCode) : null;
  const ref = (fromCode ?? body.referrer ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ref)) return c.json({ error: "invalid referrer" }, 400);
  if (ref === user) return c.json({ error: "cannot refer self" }, 400);

  const existing = await c.env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
    .bind(user)
    .first<{ referrer: string | null }>();
  if (existing?.referrer) return c.json({ error: "already bound", referrer: existing.referrer }, 409);

  const platformRoot = (await readVaultOwner(c.env)).toLowerCase();
  if (user === platformRoot) {
    await upsertUser(c.env, user, ref);
    return c.json({ ok: true, referrer: ref });
  }

  // 链条连通性：referrer 必须自己已有上级，平台 owner 例外
  const resolved = await resolveReferrer(c.env, user, ref);
  if (!resolved) return c.json({ error: "referrer has no upline" }, 400);

  // 环检测：沿 ref 的上级链查 6 跳，遇到 self 拒绝
  let cursor = resolved;
  for (let i = 0; i < 6; i++) {
    const r = await c.env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
      .bind(cursor)
      .first<{ referrer: string | null }>();
    if (!r?.referrer) break;
    if (r.referrer === user) return c.json({ error: "circular referral" }, 400);
    cursor = r.referrer;
  }

  await upsertUser(c.env, user, resolved);
  return c.json({ ok: true, referrer: resolved });
});
