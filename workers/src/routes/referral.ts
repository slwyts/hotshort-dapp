import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser } from "./auth";
import { upsertUser } from "../lib/users";

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

/**
 * GET /referral/tree
 * 当前用户作为上级时，三代下线列表 + 各代人数 + 累计返佣（USDT）。
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

  // 累计返佣 USDT
  const reward = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN reward_token = 'USDT' THEN CAST(reward_amount AS REAL) ELSE 0 END), 0) AS usdt,
       COALESCE(SUM(CASE WHEN reward_token = 'STOCK' THEN CAST(reward_amount AS REAL) ELSE 0 END), 0) AS stock,
       COALESCE(SUM(CASE WHEN reward_token = 'HS' THEN CAST(reward_amount AS REAL) ELSE 0 END), 0) AS hs,
       COUNT(*) AS count
     FROM referral_rewards WHERE user = ?`,
  )
    .bind(user)
    .first<{ usdt: number; stock: number; hs: number; count: number }>();

  return c.json({
    counts: { gen1: gen1.length, gen2: gen2.length, gen3: gen3.length },
    members: { gen1, gen2, gen3 },
    rewardsTotal: {
      usdtWei: reward?.usdt.toString() ?? "0",
      stockWei: reward?.stock.toString() ?? "0",
      hsWei: reward?.hs.toString() ?? "0",
      count: reward?.count ?? 0,
    },
  });
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

/**
 * POST /referral/bind  { referrer }
 * 用户登录后手动绑定上级。规则：
 *   - referrer 必须是合法地址，且不能等于自己
 *   - 一旦绑定成功，不能再修改（防止洗榜）
 *   - 不允许形成环（referrer 的祖先链中不能出现自己）
 */
referral.post("/bind", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { referrer?: string };
  const ref = (body.referrer ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ref)) return c.json({ error: "invalid referrer" }, 400);
  if (ref === user) return c.json({ error: "cannot refer self" }, 400);

  const existing = await c.env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
    .bind(user)
    .first<{ referrer: string | null }>();
  if (existing?.referrer) return c.json({ error: "already bound", referrer: existing.referrer }, 409);

  // 环检测：沿 ref 的上级链查 6 跳，遇到 self 拒绝
  let cursor = ref;
  for (let i = 0; i < 6; i++) {
    const r = await c.env.DB.prepare("SELECT referrer FROM users WHERE address = ?")
      .bind(cursor)
      .first<{ referrer: string | null }>();
    if (!r?.referrer) break;
    if (r.referrer === user) return c.json({ error: "circular referral" }, 400);
    cursor = r.referrer;
  }

  await upsertUser(c.env, user, ref);
  return c.json({ ok: true, referrer: ref });
});
