import { Hono } from "hono";
import type { Env } from "../env";
import { readHsPriceUsdt } from "../lib/hs-price";
import { getStockQuote } from "../lib/stocks";
import { getStockMarketStatus } from "../lib/stock-trade";
import { nowSeconds } from "../lib/time";

export const oracle = new Hono<{ Bindings: Env }>();

oracle.get("/hs-price", async (c) => {
  const price = await readHsPriceUsdt(c.env);
  return c.json({ priceUsdt: price });
});

oracle.get("/stock-price", async (c) => {
  const [quote, market] = await Promise.all([
    getStockQuote(c.env),
    getStockMarketStatus(c.env),
  ]);
  return c.json({
    ...quote,
    tradePaused: market.closed,
    marketClosed: market.closed,
    marketMode: market.mode,
    manualClosed: market.manualClosed,
    autoClosed: market.autoClosed,
    marketClosedReason: market.reason,
    market,
  });
});

/** GET /oracle/server-time  服务器时间（尊重时间偏移），前端用于替代 Date.now() 做业务到期判断 */
oracle.get("/server-time", async (c) => {
  return c.json({ nowSeconds: await nowSeconds(c.env) });
});
