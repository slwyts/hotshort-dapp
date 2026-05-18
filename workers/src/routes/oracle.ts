import { Hono } from "hono";
import type { Env } from "../env";
import { readHsPriceUsdt } from "../lib/hs-price";

export const oracle = new Hono<{ Bindings: Env }>();

oracle.get("/hs-price", async (c) => {
  const price = await readHsPriceUsdt(c.env);
  return c.json({ priceUsdt: price });
});

oracle.get("/stock-price", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT value, updated_at FROM admin_config WHERE key = 'stock_price_usdt'",
  ).first<{ value: string; updated_at: number }>();
  const price = Number(row?.value ?? 1);
  return c.json({
    priceUsdt: price > 0 ? price : 1,
    updatedAt: row?.updated_at ?? null,
  });
});
