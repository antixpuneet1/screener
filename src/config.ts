import "dotenv/config";

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
  provider: str("DATA_PROVIDER", "mock").toLowerCase(),

  // --- Kite Connect (Zerodha) settings, used only when DATA_PROVIDER=kite ---
  kiteApiKey: str("KITE_API_KEY", ""),
  kiteAccessToken: str("KITE_ACCESS_TOKEN", ""),
  kiteBaseUrl: str("KITE_BASE_URL", "https://api.kite.trade"),

  /** How often the screener re-scans the full universe, in milliseconds. */
  refreshIntervalMs: num("REFRESH_INTERVAL_MS", 10_000),

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
