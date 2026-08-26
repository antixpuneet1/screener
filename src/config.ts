import { loadEnv } from "./bootstrap.js";

loadEnv();

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: num("PORT", 4000),

  /** Which DataProvider implementation to use. Add new providers in src/providers/index.ts. */
  provider: str("DATA_PROVIDER", "upstox").toLowerCase(),

  // --- Upstox settings, used only when DATA_PROVIDER=upstox ---
  upstoxAccessToken: str("UPSTOX_ACCESS_TOKEN", ""),
  upstoxBaseUrl: str("UPSTOX_BASE_URL", "https://api.upstox.com/v2"),
  upstoxInstrumentsUrl: str(
    "UPSTOX_INSTRUMENTS_URL",
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz",
  ),
  /** Upstox's documented cap is 25 req/s, 250/min, 1000/30min; default stays well under
   *  the per-minute/30-min ceilings for a full-universe scan. Raise if your app's assigned
   *  limits allow more. */
  upstoxQuoteRateLimitPerSecond: num("UPSTOX_QUOTE_RATE_LIMIT_PER_SECOND", 8),

  /** How often the screener re-scans the full universe, in milliseconds. Keep this high
   *  enough that (contract count / maxQuoteBatchSize) requests per cycle stays well under
   *  your provider's per-minute rate limit — see README for sizing guidance. */
  refreshIntervalMs: num("REFRESH_INTERVAL_MS", 20_000),

  /** Instruments cache TTL: how often the F&O universe/instrument master is re-synced. */
  instrumentRefreshMs: num("INSTRUMENT_REFRESH_MS", 30 * 60_000),

  /** IST market hours (24h "HH:MM"). Scanning pauses outside this window. */
  marketOpen: str("MARKET_OPEN", "09:15"),
  marketClose: str("MARKET_CLOSE", "15:30"),

  /** Set true to ignore market-hours gating (useful for demos/testing). */
  ignoreMarketHours: str("IGNORE_MARKET_HOURS", "false").toLowerCase() === "true",

  /** Max retries for a rate-limited/failed provider request before giving up on that batch. */
  maxRetries: num("MAX_RETRIES", 4),
} as const;
