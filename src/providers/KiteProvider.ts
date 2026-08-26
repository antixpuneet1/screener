import { parse } from "csv-parse/sync";
import type { DataProvider, OptionInstrument, OptionQuote, OptionType } from "../types.js";
import { config } from "../config.js";
import { RateLimiter, withRetry } from "../rateLimiter.js";
import { currentSessionDate } from "../marketHours.js";

interface KiteConfig {
  apiKey: string;
  accessToken: string;
  baseUrl: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Live DataProvider backed by Zerodha's Kite Connect REST API.
 *
 * The full F&O option universe is derived automatically from Kite's own instrument
 * master (GET /instruments/NFO) on every refresh cycle, so the set of underlyings,
 * strikes and expiries always reflects NSE's current F&O list — nothing here is
 * hardcoded, and additions/removals from the exchange are picked up without a
 * code change (see config.instrumentRefreshMs).
 *
 * To connect a different broker/vendor, implement the DataProvider interface the
 * same way this class does and register it in providers/index.ts.
 */
export class KiteProvider implements DataProvider {
  readonly name = "kite";
  readonly maxQuoteBatchSize = 500;
  readonly quoteRateLimitPerSecond = 3;

  private readonly cfg: KiteConfig;
  private readonly rateLimiter: RateLimiter;

  private instrumentsCache: OptionInstrument[] = [];
  private instrumentsCachedAt = 0;

  /** Proxy for "previous session's closing OI", captured from the first live quote of each
   *  trading day per instrument, since Kite's real-time quote endpoint does not expose
   *  the prior day's closing OI directly. Reset every session so Change in OI is always
   *  computed against today's opening reference. For an exact prior-close OI, feed a
   *  once-daily historical-data snapshot into `seedChangeInOiBaseline` before market open. */
  private oiBaseline = new Map<string, number>();
  private oiBaselineSessionDate = currentSessionDate();

  constructor(overrides: Partial<KiteConfig> = {}) {
    this.cfg = {
      apiKey: overrides.apiKey ?? config.kiteApiKey,
      accessToken: overrides.accessToken ?? config.kiteAccessToken,
      baseUrl: overrides.baseUrl ?? config.kiteBaseUrl,
    };
    if (!this.cfg.apiKey || !this.cfg.accessToken) {
      throw new Error(
        "KiteProvider requires KITE_API_KEY and KITE_ACCESS_TOKEN to be set. " +
          "Generate an access token via the Kite Connect login flow and set it in your .env.",
      );
    }
    this.rateLimiter = new RateLimiter(this.quoteRateLimitPerSecond);
  }

  /** Optionally seed exact previous-day closing OI per tradingsymbol (e.g. "NFO:RELIANCE24DEC2980CE")
   *  from a nightly historical-data job, for more accurate Change in OI than the session-open proxy. */
  seedChangeInOiBaseline(baseline: Map<string, number>): void {
    this.oiBaseline = new Map(baseline);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.cfg.apiKey}:${this.cfg.accessToken}`,
      "X-Kite-Version": "3",
    };
  }

  private async request(path: string): Promise<Response> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(res.status, `Kite API ${path} failed: ${res.status} ${body}`);
    }
    return res;
  }

  async getOptionInstruments(): Promise<OptionInstrument[]> {
    const isStale = Date.now() - this.instrumentsCachedAt > config.instrumentRefreshMs;
    if (this.instrumentsCache.length > 0 && !isStale) return this.instrumentsCache;

    const res = await withRetry(() => this.request("/instruments/NFO"), {
      maxRetries: config.maxRetries,
    });
    const csv = await res.text();
    const rows = parse(csv, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;

    const instruments: OptionInstrument[] = [];
    for (const row of rows) {
      const instrumentType = row.instrument_type;
      if (instrumentType !== "CE" && instrumentType !== "PE") continue;

      const tradingSymbol = row.tradingsymbol;
      instruments.push({
        instrumentToken: `NFO:${tradingSymbol}`,
        underlying: row.name,
        optionType: instrumentType as OptionType,
        strike: Number(row.strike),
        expiry: row.expiry,
        tradingSymbol,
        lotSize: Number(row.lot_size) || 0,
      });
    }

    this.instrumentsCache = instruments;
    this.instrumentsCachedAt = Date.now();
    return instruments;
  }

  async getQuotes(instrumentTokens: string[]): Promise<Map<string, OptionQuote>> {
    this.resetOiBaselineIfNewSession();
    if (instrumentTokens.length === 0) return new Map();
    if (instrumentTokens.length > this.maxQuoteBatchSize) {
      throw new Error(
        `getQuotes received ${instrumentTokens.length} instruments, exceeding maxQuoteBatchSize=${this.maxQuoteBatchSize}. Callers must chunk requests.`,
      );
    }

    await this.rateLimiter.acquire();

    const qs = instrumentTokens.map((t) => `i=${encodeURIComponent(t)}`).join("&");
    const res = await withRetry(() => this.request(`/quote?${qs}`), {
      maxRetries: config.maxRetries,
    });
    const payload = (await res.json()) as {
      data: Record<
        string,
        {
          timestamp: string;
          last_price: number;
          volume: number;
          oi: number;
          ohlc: { open: number; high: number; low: number; close: number };
        }
      >;
    };

    const out = new Map<string, OptionQuote>();
    for (const [token, q] of Object.entries(payload.data)) {
      if (!this.oiBaseline.has(token)) this.oiBaseline.set(token, q.oi);
      const baseline = this.oiBaseline.get(token) ?? q.oi;

      out.set(token, {
        instrumentToken: token,
        open: q.ohlc.open,
        high: q.ohlc.high,
        low: q.ohlc.low,
        close: q.ohlc.close,
        ltp: q.last_price,
        volume: q.volume,
        oi: q.oi,
        changeInOi: q.oi - baseline,
        // Kite timestamps are "YYYY-MM-DD HH:mm:ss" in IST with no offset marker.
        timestamp: new Date(q.timestamp.replace(" ", "T") + "+05:30"),
      });
    }
    return out;
  }

  private resetOiBaselineIfNewSession(): void {
    const today = currentSessionDate();
    if (today !== this.oiBaselineSessionDate) {
      this.oiBaselineSessionDate = today;
      this.oiBaseline.clear();
    }
  }
}
