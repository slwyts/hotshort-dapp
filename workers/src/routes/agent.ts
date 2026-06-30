import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser } from "./auth";
import {
  acknowledgeAgentAlerts,
  type AgentDateRange,
  getAgentSummary,
  getAgentUser,
  getUserFinancialSummary,
  isEnabledAgent,
  listAgentAlerts,
  listAgentTransactions,
  listAgentUsers,
  listUserTransactions,
  readAgentAccount,
} from "../lib/agent-data";

export const agent = new Hono<{ Bindings: Env }>();

async function requireAgent(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const user = await requireUser(c);
  if (!user) return null;
  return (await isEnabledAgent(c.env, user)) ? user : null;
}

function querySeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function queryDateRange(c: Context<{ Bindings: Env }>): AgentDateRange {
  const from = querySeconds(c.req.query("from"));
  const to = querySeconds(c.req.query("to"));
  if (from !== undefined && to !== undefined && to <= from) return {};
  return { from, to };
}

function queryDirection(value: string | undefined): "all" | "deposit" | "withdraw" | "spend" | "credit" {
  return value === "deposit" || value === "withdraw" || value === "spend" || value === "credit" ? value : "all";
}

agent.get("/me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const account = await readAgentAccount(c.env, user);
  return c.json({
    address: user,
    isAgent: account?.enabled === 1,
    label: account?.label ?? null,
    enabled: account?.enabled === 1,
  });
});

agent.get("/summary", async (c) => {
  const account = await requireAgent(c);
  if (!account) return c.json({ error: "forbidden" }, 403);
  return c.json(await getAgentSummary(c.env, account));
});

agent.get("/users", async (c) => {
  const account = await requireAgent(c);
  if (!account) return c.json({ error: "forbidden" }, 403);
  const q = c.req.query("q") ?? "";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 100);
  const cursor = Math.max(Number(c.req.query("cursor") ?? 0), 0);
  const users = await listAgentUsers(c.env, account, q);
  const page = users.slice(cursor, cursor + limit);
  const items = [];
  for (const user of page) {
    items.push({ ...user, funds: await getUserFinancialSummary(c.env, user.address) });
  }
  return c.json({ items, nextCursor: cursor + limit < users.length ? String(cursor + limit) : null, total: users.length });
});

agent.get("/users/:address", async (c) => {
  const account = await requireAgent(c);
  if (!account) return c.json({ error: "forbidden" }, 403);
  const user = await getAgentUser(c.env, account, c.req.param("address"));
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json({ user, funds: await getUserFinancialSummary(c.env, user.address) });
});

agent.get("/users/:address/transactions", async (c) => {
  const account = await requireAgent(c);
  if (!account) return c.json({ error: "forbidden" }, 403);
  const user = await getAgentUser(c.env, account, c.req.param("address"));
  if (!user) return c.json({ error: "not found" }, 404);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);
  const cursor = Math.max(Number(c.req.query("cursor") ?? 0), 0);
  const txs = await listUserTransactions(c.env, user.address);
  return c.json({ items: txs.slice(cursor, cursor + limit), nextCursor: cursor + limit < txs.length ? String(cursor + limit) : null });
});

agent.get("/transactions", async (c) => {
  const account = await requireAgent(c);
  if (!account) return c.json({ error: "forbidden" }, 403);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);
  const cursor = Math.max(Number(c.req.query("cursor") ?? 0), 0);
  const result = await listAgentTransactions(c.env, account, {
    range: queryDateRange(c),
    q: c.req.query("q") ?? "",
    direction: queryDirection(c.req.query("direction")),
    type: c.req.query("type") ?? "all",
  });
  return c.json({
    items: result.items.slice(cursor, cursor + limit),
    summary: result.summary,
    nextCursor: cursor + limit < result.items.length ? String(cursor + limit) : null,
    total: result.items.length,
  });
});

agent.get("/alerts", async (c) => {
  const account = await requireAgent(c);
  if (!account) return c.json({ error: "forbidden" }, 403);
  const threshold = Number(c.req.query("thresholdUsdt") ?? 500);
  const unreadOnly = c.req.query("unreadOnly") === "1";
  return c.json({ items: await listAgentAlerts(c.env, account, Number.isFinite(threshold) ? threshold : 500, unreadOnly) });
});

agent.post("/alerts/ack", async (c) => {
  const account = await requireAgent(c);
  if (!account) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { alertIds?: string[] };
  if (!Array.isArray(body.alertIds)) return c.json({ error: "bad payload" }, 400);
  return c.json({ acknowledged: await acknowledgeAgentAlerts(c.env, account, body.alertIds) });
});
