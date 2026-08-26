import { gunzipSync } from "node:zlib";
import type { DataProvider, OptionInstrument, OptionQuote, OptionType } from "../types.js";
import { config } from "../config.js";
import { RateLimiter, withRetry } from "../rateLimiter.js";
import { currentSessionDate } from "../marketHours.js";

interface UpstoxConfig {
  accessToken: string;
  baseUrl: string;
  instrumentsUrl: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface UpstoxInstrumentRow {
  segment: string;
  instrument_key: string;
  trading_symbol: string;
  instrument_type: string;
  strike_price?: number;
  expiry?: string;
  lot_size: number;
  underlying_symbol?: string;
  name?: string;
}

interface UpstoxQuoteRow {
  instrument_token: string;
  timestamp?: number | string;
  last_trade_time?: number | string;
  last_price: number;
  volume: number;
  oi: number;
  ohlc: { open: number; high: number; low: number; close: number };
}

/**
 * Live DataProvider backed by the Upstox API.
 *
 * The full F&O option universe is derived automatically from Upstox's own published
 * instrument master (the NSE.json.gz snapshot at instrumentsUrl) on every refresh
 * cycle, so the set of underlyings, strikes and expiries always reflects NSE's
 * current F&O list — nothing is hardcoded, and additions/removals from the exchange
 * are picked up without a code change (see config.instrumentRefreshMs). Upstox
 * refreshes this file daily (~6 AM IST) and occasionally intraday.
 *
 * To connect a different broker/vendor, implement the DataProvider interface the
 * same way this class does and register it in providers/index.ts.
 */
export class UpstoxProvider implements DataProvider {
  readonly name = "upstox";
  readonly maxQuoteBatchSize = 500;
  readonly quoteRateLimitPerSecond: number;

  private readonly cfg: UpstoxConfig;
  private readonly rateLimiter: RateLimiter;

  private instrumentsCache: OptionInstrument[] = [];
  private instrumentsCachedAt = 0;

  /** Proxy for "previous session's closing OI", captured from the first live quote of each
   *  trading day per instrument, since Upstox's real-time quote endpoint does not expose
   *  the prior day's closing OI directly. Reset every session so Change in OI is always
   *  computed against today's opening reference. For an exact prior-close OI, feed a
   *  once-daily historical-data snapshot into `seedChangeInOiBaseline` before market open. */
  private oiBaseline = new Map<string, number>();
  private oiBaselineSessionDate = currentSessionDate();

  constructor(overrides: Partial<UpstoxConfig> = {}) {
    this.cfg = {
      accessToken: overrides.accessToken ?? config.upstoxAccessToken,
      baseUrl: overrides.baseUrl ?? config.upstoxBaseUrl,
      instrumentsUrl: overrides.instrumentsUrl ?? config.upstoxInstrumentsUrl,
    };
    if (!this.cfg.accessToken) {
      throw new Error(
        "No Upstox access token configured. Add one in the Settings panel (or set " +
          "UPSTOX_ACCESS_TOKEN in .env). Tokens come from the Upstox OAuth login flow and " +
          "expire daily around 3:30am IST.",
      );
    }
    this.quoteRateLimitPerSecond = config.upstoxQuoteRateLimitPerSecond;
    this.rateLimiter = new RateLimiter(this.quoteRateLimitPerSecond);
  }

  /** Optionally seed exact previous-day closing OI per instrument_key from a nightly
   *  historical-data job, for more accurate Change in OI than the session-open proxy. */
  seedChangeInOiBaseline(baseline: Map<string, number>): void {
    this.oiBaseline = new Map(baseline);
  }

  /**
   * Checks a token against Upstox's profile endpoint, so the settings page can tell a
   * bad/expired token from a working one before saving. Deliberately status-based rather
   * than body-shape-based, so it stays correct regardless of the response payload.
   */
  static async validateToken(
    token: string,
    baseUrl = config.upstoxBaseUrl,
  ): Promise<{ ok: boolean; message: string }> {
    if (!token.trim()) return { ok: false, message: "Token is empty." };
    try {
      const res = await fetch(`${baseUrl}/user/profile`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.ok) return { ok: true, message: "Token accepted by Upstox." };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: "Upstox rejected this token (401/403). It may be expired — tokens expire daily around 3:30am IST." };
      }
      return { ok: false, message: `Upstox returned HTTP ${res.status}. Token may still be valid; try again shortly.` };
    } catch (err) {
      return { ok: false, message: `Could not reach Upstox: ${(err as Error).message}` };
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      Accept: "application/json",
    };
  }

  private async request(path: string): Promise<Response> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(res.status, `Upstox API ${path} failed: ${res.status} ${body}`);
    }
    return res;
  }

  async getOptionInstruments(): Promise<OptionInstrument[]> {
    const isStale = Date.now() - this.instrumentsCachedAt > config.instrumentRefreshMs;
    if (this.instrumentsCache.length > 0 && !isStale) return this.instrumentsCache;

    const res = await withRetry(() => fetch(this.cfg.instrumentsUrl), {
      maxRetries: config.maxRetries,
    });
    if (!res.ok) {
      throw new HttpError(res.status, `Failed to download Upstox instrument master: ${res.status}`);
    }
    const gzipped = Buffer.from(await res.arrayBuffer());
    const rows = JSON.parse(gunzipSync(gzipped).toString("utf-8")) as UpstoxInstrumentRow[];

    const instruments: OptionInstrument[] = [];
    for (const row of rows) {
      const optionType = row.instrument_type;
      if (row.segment !== "NSE_FO") continue;
      if (optionType !== "CE" && optionType !== "PE") continue;
      if (row.strike_price === undefined || !row.expiry) continue;

      instruments.push({
        instrumentToken: row.instrument_key,
        underlying: row.underlying_symbol ?? row.name ?? row.trading_symbol,
        optionType: optionType as OptionType,
        strike: row.strike_price,
        expiry: row.expiry,
        tradingSymbol: row.trading_symbol,
        lotSize: row.lot_size ?? 0,
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

    const qs = `instrument_key=${encodeURIComponent(instrumentTokens.join(","))}`;
    const res = await withRetry(() => this.request(`/market-quote/quotes?${qs}`), {
      maxRetries: config.maxRetries,
    });
    const payload = (await res.json()) as { data: Record<string, UpstoxQuoteRow> };

    const out = new Map<string, OptionQuote>();
    for (const q of Object.values(payload.data)) {
      const token = q.instrument_token;
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
        timestamp: this.parseTimestamp(q.timestamp ?? q.last_trade_time),
      });
    }
    return out;
  }

  private parseTimestamp(raw: number | string | undefined): Date {
    if (raw === undefined) return new Date();
    if (typeof raw === "number") return new Date(raw);
    const asNumber = Number(raw);
    return Number.isFinite(asNumber) ? new Date(asNumber) : new Date(raw);
  }

  private resetOiBaselineIfNewSession(): void {
    const today = currentSessionDate();
    if (today !== this.oiBaselineSessionDate) {
      this.oiBaselineSessionDate = today;
      this.oiBaseline.clear();
    }
  }
}
