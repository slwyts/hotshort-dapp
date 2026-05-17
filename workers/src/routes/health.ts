import { Hono } from "hono";
import type { Env } from "../env";

export const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  let dbOk = false;
  try {
    await c.env.DB.prepare("SELECT 1").first();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return c.json({
    ok: true,
    db: dbOk,
    chainId: c.env.CHAIN_ID,
    vault: c.env.VAULT_ADDRESS,
    ts: Math.floor(Date.now() / 1000),
  });
});
