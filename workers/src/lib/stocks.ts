import type { Env } from "../env";
import { nowSeconds } from "./time";
import { readHsPriceUsdt } from "./hs-price";
import { STOCK_DISPLAY_NAME, STOCK_QUOTE_PROVIDER, STOCK_SYMBOL } from "@/lib/constants/business-rules";

const SCALE = 10n ** 18n;
const STOCK_QUOTE_STALE_SECONDS = 15 * 60;
const STOCK_QUOTE_FETCH_TIMEOUT_MS = 6_000;

export type StockQuoteMode = "auto" | "manual";

export interface Holdings {
  total: bigint;
  locked: bigint;
}

export interface SellableHoldings extends Holdings {
  available: bigint;
}

export interface StockQuote {
  symbol: string;
  name: string;
  priceUsdt: number;
  source: string;
  updatedAt: number | null;
  syncedAt: number | null;
  fallback: boolean;
  mode: StockQuoteMode;
}

export interface StockQuoteSyncResult {
  synced: boolean;
  reason: "ok" | "manual" | "fresh" | "fetch_failed";
  quote: StockQuote;
}

interface StockQuoteConfig {
  mode: StockQuoteMode;
  priceUsdt: number;
  provider: string;
  updatedAt: number | null;
}

export async function getHoldings(env: Env, user: string): Promise<Holdings> {
  const u = user.toLowerCase();
  const row = await env.DB.prepare(
    "SELECT total_stock, locked_stock FROM stock_holdings WHERE user = ?",
  )
    .bind(u)
    .first<{ total_stock: string; locked_stock: string }>();
  if (!row) return { total: 0n, locked: 0n };
  return { total: BigInt(row.total_stock), locked: BigInt(row.locked_stock) };
}

export async function getSellableHoldings(env: Env, user: string): Promise<SellableHoldings> {
  const holdings = await getHoldings(env, user);
  const available = holdings.total > holdings.locked ? holdings.total - holdings.locked : 0n;
  return { ...holdings, available };
}

/** 增加用户股票余额（购买赠送 / 分红 / 闪兑） */
export async function addStock(env: Env, user: string, amount: bigint, locked = false): Promise<void> {
  if (amount <= 0n) return;
  const u = user.toLowerCase();
  const now = await nowSeconds(env);
  const { total, locked: lk } = await getHoldings(env, u);
  const newTotal = total + amount;
  const newLocked = locked ? lk + amount : lk;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO stock_holdings (user, total_stock, locked_stock, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(u, newTotal.toString(), newLocked.toString(), now)
    .run();
}

/** 减少用户股票余额（领取分红时不动 holdings；卖出/解锁时才用） */
export async function decLockedStock(env: Env, user: string, amount: bigint): Promise<void> {
  if (amount <= 0n) return;
  const u = user.toLowerCase();
  const now = await nowSeconds(env);
  const { locked } = await getHoldings(env, u);
  const newLocked = locked > amount ? locked - amount : 0n;
  await env.DB.prepare(
    "UPDATE stock_holdings SET locked_stock = ?, updated_at = ? WHERE user = ?",
  )
    .bind(newLocked.toString(), now, u)
    .run();
}

export async function sellAvailableStock(env: Env, user: string, amount: bigint): Promise<SellableHoldings> {
  if (amount <= 0n) throw new Error("bad stock amount");
  const u = user.toLowerCase();
  const holdings = await getSellableHoldings(env, u);
  if (holdings.available < amount) throw new Error("insufficient available stock");
  const now = await nowSeconds(env);
  const newTotal = holdings.total - amount;
  await env.DB.prepare(
    "UPDATE stock_holdings SET total_stock = ?, updated_at = ? WHERE user = ?",
  )
    .bind(newTotal.toString(), now, u)
    .run();
  return {
    total: newTotal,
    locked: holdings.locked,
    available: newTotal > holdings.locked ? newTotal - holdings.locked : 0n,
  };
}

export async function getManualStockPriceUsdt(env: Env): Promise<{ price: number; updatedAt: number | null }> {
  const row = await env.DB.prepare(
    "SELECT value, updated_at FROM admin_config WHERE key = 'stock_price_usdt'",
  ).first<{ value: string; updated_at: number }>();
  const v = Number(row?.value ?? 1);
  return { price: v > 0 ? v : 1, updatedAt: row?.updated_at ?? null };
}

function normalizeStockQuoteMode(value: string | null | undefined): StockQuoteMode {
  return value === "manual" ? "manual" : "auto";
}

async function readStockQuoteConfig(env: Env): Promise<StockQuoteConfig> {
  const rows = await env.DB.prepare(
    "SELECT key, value, updated_at FROM admin_config WHERE key IN ('stock_price_usdt','stock_price_provider','stock_quote_mode')",
  ).all<{ key: string; value: string; updated_at: number }>();
  const map = new Map<string, { value: string; updatedAt: number }>();
  for (const row of rows.results ?? []) map.set(row.key, { value: row.value, updatedAt: row.updated_at });

  const price = Number(map.get("stock_price_usdt")?.value ?? 1);
  return {
    mode: normalizeStockQuoteMode(map.get("stock_quote_mode")?.value ?? env.STOCK_QUOTE_MODE),
    priceUsdt: Number.isFinite(price) && price > 0 ? price : 1,
    provider: map.get("stock_price_provider")?.value || "manual",
    updatedAt: map.get("stock_price_usdt")?.updatedAt ?? null,
  };
}

async function writeAdminConfig(env: Env, rows: [string, string][], updatedBy: string, updatedAt: number): Promise<void> {
  for (const [key, value] of rows) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO admin_config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(key, value, updatedBy, updatedAt)
      .run();
  }
}

function quoteFromConfig(config: StockQuoteConfig): StockQuote {
  return {
    symbol: STOCK_SYMBOL,
    name: STOCK_DISPLAY_NAME,
    priceUsdt: config.priceUsdt,
    source: config.provider || "manual",
    updatedAt: config.updatedAt,
    syncedAt: config.updatedAt,
    fallback: config.provider === "manual",
    mode: config.mode,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("stock quote request timeout"));
        }, STOCK_QUOTE_FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return Number.NaN;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

async function fetchNasdaqQuote(): Promise<StockQuote | null> {
  const url = `https://api.nasdaq.com/api/quote/${STOCK_SYMBOL}/info?assetclass=stocks`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "user-agent": "Mozilla/5.0 (compatible; HotshortDapp/1.0)",
      "origin": "https://www.nasdaq.com",
      "referer": `https://www.nasdaq.com/market-activity/stocks/${STOCK_SYMBOL.toLowerCase()}`,
    },
  });
  if (!res.ok) return null;
  const json = await res.json() as {
    data?: {
      symbol?: string;
      primaryData?: {
        lastSalePrice?: string;
        lastTradeTimestamp?: string;
      };
    };
  };
  const price = parseNumber(json.data?.primaryData?.lastSalePrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const timestamp = json.data?.primaryData?.lastTradeTimestamp
    ? Math.floor(Date.parse(json.data.primaryData.lastTradeTimestamp) / 1000)
    : null;
  return {
    symbol: json.data?.symbol || STOCK_SYMBOL,
    name: STOCK_DISPLAY_NAME,
    priceUsdt: price,
    source: "Nasdaq",
    updatedAt: Number.isFinite(timestamp) ? timestamp : null,
    syncedAt: null,
    fallback: false,
    mode: "auto",
  };
}

async function fetchStooqQuote(): Promise<StockQuote | null> {
  const url = `https://stooq.com/q/l/?s=${STOCK_SYMBOL.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetchWithTimeout(url, { headers: { "accept": "text/csv,*/*" } });
  if (!res.ok) return null;
  const text = await res.text();
  const [, row] = text.trim().split(/\r?\n/);
  if (!row) return null;
  const [symbol, date, time, , , , close] = row.split(",");
  const price = parseNumber(close);
  if (!Number.isFinite(price) || price <= 0) return null;
  const timestamp = date && time ? Math.floor(Date.parse(`${date}T${time}Z`) / 1000) : null;
  return {
    symbol: symbol?.replace(".US", "") || STOCK_SYMBOL,
    name: STOCK_DISPLAY_NAME,
    priceUsdt: price,
    source: "Stooq",
    updatedAt: Number.isFinite(timestamp) ? timestamp : null,
    syncedAt: null,
    fallback: false,
    mode: "auto",
  };
}

async function fetchYahooQuote(): Promise<StockQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${STOCK_SYMBOL}?range=1d&interval=1m`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "user-agent": "Mozilla/5.0 (compatible; HotshortDapp/1.0)",
    },
  });
  if (!res.ok) return null;
  const json = await res.json() as {
    chart?: {
      result?: Array<{
        meta?: {
          symbol?: string;
          longName?: string;
          shortName?: string;
          regularMarketPrice?: number;
          regularMarketTime?: number;
        };
      }>;
    };
  };
  const meta = json.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    symbol: meta?.symbol || STOCK_SYMBOL,
    name: STOCK_DISPLAY_NAME,
    priceUsdt: price,
    source: STOCK_QUOTE_PROVIDER,
    updatedAt: Number(meta?.regularMarketTime) || null,
    syncedAt: null,
    fallback: false,
    mode: "auto",
  };
}

async function fetchMarketStockQuote(): Promise<StockQuote | null> {
  const sources = [fetchNasdaqQuote, fetchStooqQuote, fetchYahooQuote];
  return Promise.any(
    sources.map(async (source) => {
      const quote = await source();
      if (!quote) throw new Error("quote unavailable");
      return quote;
    }),
  ).catch(() => null);
}

function needsStockQuoteSync(config: StockQuoteConfig, now: number): boolean {
  if (config.mode !== "auto") return false;
  if (config.provider === "manual") return true;
  if (!config.updatedAt) return true;
  return now - config.updatedAt >= STOCK_QUOTE_STALE_SECONDS;
}

export async function syncStockQuote(env: Env, options: { force?: boolean; updatedBy?: string } = {}): Promise<StockQuoteSyncResult> {
  const config = await readStockQuoteConfig(env);
  const current = quoteFromConfig(config);
  const now = await nowSeconds(env);

  if (!options.force && config.mode !== "auto") {
    return { synced: false, reason: "manual", quote: current };
  }
  if (!options.force && !needsStockQuoteSync(config, now)) {
    return { synced: false, reason: "fresh", quote: current };
  }

  const quote = await fetchMarketStockQuote().catch(() => null);
  if (!quote) return { synced: false, reason: "fetch_failed", quote: current };

  await writeAdminConfig(
    env,
    [
      ["stock_price_usdt", String(quote.priceUsdt)],
      ["stock_price_provider", quote.source],
      ["stock_symbol", quote.symbol],
    ],
    options.updatedBy ?? "stock-sync",
    now,
  );

  return {
    synced: true,
    reason: "ok",
    quote: { ...quote, mode: config.mode, syncedAt: now },
  };
}

export async function setStockQuoteMode(env: Env, mode: StockQuoteMode, updatedBy: string): Promise<StockQuote> {
  const now = await nowSeconds(env);
  await writeAdminConfig(env, [["stock_quote_mode", mode]], updatedBy, now);
  return getStockQuote(env);
}

export async function setManualStockPrice(env: Env, priceUsdt: number, updatedBy: string): Promise<StockQuote> {
  const now = await nowSeconds(env);
  await writeAdminConfig(
    env,
    [
      ["stock_price_usdt", String(priceUsdt)],
      ["stock_price_provider", "manual"],
    ],
    updatedBy,
    now,
  );
  const config = await readStockQuoteConfig(env);
  return quoteFromConfig(config);
}

export async function getStockQuote(env: Env, options: { refresh?: boolean } = {}): Promise<StockQuote> {
  const config = await readStockQuoteConfig(env);
  if (options.refresh) {
    const result = await syncStockQuote(env, { force: options.refresh, updatedBy: options.refresh ? "manual-sync" : "stock-refresh" });
    return result.quote;
  }
  return quoteFromConfig(config);
}

/** 当前股价（USDT），生产优先真实 WTO 行情，失败回退后台手动价 */
export async function getStockPriceUsdt(env: Env): Promise<number> {
  return (await getStockQuote(env)).priceUsdt;
}

export async function getHsPriceUsdt(env: Env): Promise<number> {
  return readHsPriceUsdt(env);
}

/** 把 USDT (number) 折算成 18-decimal stock 单位（1 stock = stockPriceUsdt） */
export function usdtToStockWei(usdt: number, stockPriceUsdt: number): bigint {
  if (stockPriceUsdt <= 0) return 0n;
  const stockNum = usdt / stockPriceUsdt;
  return BigInt(Math.floor(stockNum * 1e18));
}

export function bigintWei(num: number): bigint {
  return BigInt(Math.floor(num * 1e18));
}

export const STOCK_SCALE = SCALE;
