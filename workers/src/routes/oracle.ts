import { Hono } from "hono";
import type { Env } from "../env";
import { readHsPriceUsdt } from "../lib/hs-price";
import { getStockQuote } from "../lib/stocks";

export const oracle = new Hono<{ Bindings: Env }>();

oracle.get("/hs-price", async (c) => {
  const price = await readHsPriceUsdt(c.env);
  return c.json({ priceUsdt: price });
});

oracle.get("/stock-price", async (c) => {
  return c.json(await getStockQuote(c.env));
});
