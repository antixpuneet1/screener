import { gunzip } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { appDir } from "../bootstrap.js";
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

/** Per-request ceiling. Without one, a stalled connection leaves a scan cycle running
 *  forever: the app then looks frozen with nothing scanned and no error to show. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The instrument master is a multi-megabyte download, so it gets a longer ceiling —
 *  but not so long that a blocked download sits invisible for minutes. */
const INSTRUMENTS_TIMEOUT_MS = 60_000;
/** Deliberately fewer than the quote retries: this runs before anything can be shown,
 *  so failing fast and reporting beats retrying behind a "loading" message. */
const INSTRUMENTS_MAX_RETRIES = 1;
/** Parsed contract list cached here so a restart doesn't re-download tens of MB. */
const INSTRUMENTS_CACHE_FILE = "instruments-cache.json";

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

/** Every field is optional/nullable: Upstox returns sparse rows for contracts that have
 *  not traded, and the whole universe is scanned including illiquid strikes. */
interface UpstoxQuoteRow {
  instrument_token?: string;
  timestamp?: number | string | null;
  last_trade_time?: number | string | null;
  last_price?: number | null;
  volume?: number | null;
  oi?: number | null;
  ohlc?: {
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
  } | null;
}

/** Finite number, or null for anything missing/null/non-numeric. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Decompresses (if needed) and parses the instrument payload off the event loop.
 *
 * This file is tens of megabytes; doing gunzip and JSON.parse synchronously froze the
 * HTTP server and WebSocket hub for the whole duration, so the dashboard stopped
 * responding exactly when it was meant to be reporting progress. Also tolerates a plain
 * (non-gzipped) JSON body, since the endpoint has served both.
 */
async function parseInstrumentPayload(raw: Buffer): Promise<UpstoxInstrumentRow[]> {
  // gzip magic number; anything else is treated as plain JSON.
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;

  let text: string;
  if (isGzip) {
    const unzipped = await new Promise<Buffer>((resolve, reject) => {
      gunzip(raw, (err, out) => (err ? reject(err) : resolve(out)));
    });
    text = unzipped.toString("utf-8");
  } else {
    text = raw.toString("utf-8");
  }

  // Yield once before the parse so pending socket writes flush first.
  await new Promise((r) => setImmediate(r));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `the response was not readable JSON (${(err as Error).message}); ` +
        `first bytes: ${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`expected a JSON array of instruments, got ${typeof parsed}`);
  }
  return parsed as UpstoxInstrumentRow[];
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

  /**
   * Upstox's documented caps. The 1000/30min ceiling is the binding one for a
   * full-universe scan: it works out to ~33 requests/minute sustained, so a universe of
   * N contracts takes roughly (N / 500 / 33) minutes per complete sweep. Set slightly
   * under each published figure to leave headroom for retries and clock skew.
   */
  readonly quoteRateWindows = [
    { limit: 20, windowMs: 1_000 },
    { limit: 240, windowMs: 60_000 },
    { limit: 950, windowMs: 30 * 60_000 },
  ] as const;

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
        "No Upstox token configured. Add one in the Settings panel (or set " +
          "UPSTOX_ACCESS_TOKEN in .env). Use either an Analytics Token (generated on the " +
          "Upstox Developer Apps page, read-only, valid 1 year) or a daily OAuth access " +
          "token (expires ~3:30am IST).",
      );
    }
    this.quoteRateLimitPerSecond = config.upstoxQuoteRateLimitPerSecond;
    // Same windows the Scanner paces against, so a direct getQuotes() caller is held to
    // the real Upstox limits rather than only the per-second one.
    this.rateLimiter = new RateLimiter([...this.quoteRateWindows]);
  }

  /** Releases the internal rate limiter's timer. The app rebuilds its provider on every
   *  settings save, so without this the timers accumulate for the process's lifetime. */
  dispose(): void {
    this.rateLimiter.dispose();
  }

  /** Optionally seed exact previous-day closing OI per instrument_key from a nightly
   *  historical-data job, for more accurate Change in OI than the session-open proxy. */
  seedChangeInOiBaseline(baseline: Map<string, number>): void {
    this.oiBaseline = new Map(baseline);
  }

  /**
   * Checks a token by making the same kind of market-data call the screener itself relies
   * on (an LTP quote for the Nifty 50 index).
   *
   * Deliberately NOT the /user/profile endpoint: an Upstox Analytics Token (the 1-year,
   * read-only kind) is scoped to market-data APIs and only reaches Account/Profile
   * endpoints from a registered static IP, so profile would report a perfectly good
   * Analytics Token as invalid. Validating against market data tests exactly the access
   * this app needs. Status-based rather than body-shape-based, so it stays correct
   * regardless of the response payload.
   */
  static async validateToken(
    token: string,
    baseUrl = config.upstoxBaseUrl,
  ): Promise<{ ok: boolean; message: string }> {
    if (!token.trim()) return { ok: false, message: "Token is empty." };
    const probe = `${baseUrl}/market-quote/ltp?instrument_key=${encodeURIComponent("NSE_INDEX|Nifty 50")}`;
    try {
      const res = await fetch(probe, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, message: "Token works — Upstox market data is reachable." };

      const body = (await res.text().catch(() => "")).slice(0, 300);

      // A 401/403 does not always come from Upstox: corporate proxies, VPNs and egress
      // filters return the same codes. Quoting the response body lets the user tell a
      // rejected token from a blocked network instead of chasing the wrong problem.
      if (res.status === 401 || res.status === 403) {
        const looksLikeNetworkBlock = /allowlist|proxy|blocked|forbidden by|firewall|gateway/i.test(body);
        if (looksLikeNetworkBlock) {
          return {
            ok: false,
            message: `Blocked before reaching Upstox (HTTP ${res.status}): ${body} — this looks like a network/proxy restriction, not a bad token.`,
          };
        }
        return {
          ok: false,
          message:
            `Upstox rejected this token (HTTP ${res.status}). Check you pasted an access token or Analytics Token — ` +
            `not your API key/secret, which are not tokens. A daily OAuth access token expires at ~3:30am IST; ` +
            `an Analytics Token lasts a year.${body ? ` Response: ${body}` : ""}`,
        };
      }
      return {
        ok: false,
        message: `HTTP ${res.status} from ${baseUrl}. ${body}`.trim(),
      };
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
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(res.status, `Upstox API ${path} failed: ${res.status} ${body}`);
    }
    return res;
  }

  async getOptionInstruments(): Promise<OptionInstrument[]> {
    const isStale = Date.now() - this.instrumentsCachedAt > config.instrumentRefreshMs;
    if (this.instrumentsCache.length > 0 && !isStale) return this.instrumentsCache;

    // On a cold start, a same-day cache on disk makes startup instant instead of
    // re-downloading tens of megabytes. On a later refresh it is skipped, so that
    // instrumentRefreshMs still picks up newly listed strikes and expiries intraday.
    if (this.instrumentsCachedAt === 0) {
      const cached = this.readDiskCache();
      if (cached) {
        console.log(`[upstox] using cached contract list (${cached.length.toLocaleString()} option contracts)`);
        this.instrumentsCache = cached;
        this.instrumentsCachedAt = Date.now();
        return cached;
      }
    }

    let rows: UpstoxInstrumentRow[];
    try {
      rows = await this.downloadInstrumentRows();
    } catch (err) {
      // A refresh that fails must not wipe a working list: keep serving what we have and
      // back off, rather than blanking the dashboard and re-downloading on every tick.
      if (this.instrumentsCache.length > 0) {
        this.instrumentsCachedAt = Date.now();
        console.error(
          `[upstox] contract list refresh failed (${(err as Error).message}); ` +
            `continuing with the ${this.instrumentsCache.length.toLocaleString()} contracts already loaded.`,
        );
        return this.instrumentsCache;
      }
      throw err;
    }

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

    console.log(
      `[upstox] contract list ready: ${instruments.length.toLocaleString()} NSE F&O option contracts ` +
        `(${new Set(instruments.map((i) => i.underlying)).size} underlyings)`,
    );
    if (instruments.length === 0) {
      throw new Error(
        `The contract list downloaded but contained no NSE F&O options (checked ${rows.length.toLocaleString()} rows). ` +
          `Upstox may have changed the file's format or segment naming.`,
      );
    }

    this.instrumentsCache = instruments;
    this.instrumentsCachedAt = Date.now();
    this.writeDiskCache(instruments);
    return instruments;
  }

  /**
   * Downloads and parses the instrument master, trying each candidate source in turn.
   *
   * Two things matter here. First, a bare Node fetch sends no User-Agent, and CDNs
   * commonly reject that with a 403 — which matches the reports of this file being
   * "blocked for automated access", so browser-like headers are sent. Second, the
   * exchange-specific file has been observed missing or empty at times, so the
   * all-exchanges file is tried as a fallback rather than failing outright.
   */
  private async downloadInstrumentRows(): Promise<UpstoxInstrumentRow[]> {
    const candidates = [
      this.cfg.instrumentsUrl,
      "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz",
    ].filter((u, i, a) => a.indexOf(u) === i);

    const failures: string[] = [];
    let lastStatus: number | undefined;

    for (const url of candidates) {
      console.log(`[upstox] downloading contract list from ${url} …`);
      const startedAt = Date.now();
      try {
        const res = await withRetry(
          () =>
            fetch(url, {
              signal: AbortSignal.timeout(INSTRUMENTS_TIMEOUT_MS),
              headers: {
                // Without these a plain Node request looks like a bot to the CDN.
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                Accept: "application/gzip,application/json,*/*",
                "Accept-Encoding": "gzip, deflate",
              },
            }),
          { maxRetries: INSTRUMENTS_MAX_RETRIES },
        );

        if (!res.ok) {
          const body = (await res.text().catch(() => "")).slice(0, 150);
          lastStatus = res.status;
          failures.push(`${url} → HTTP ${res.status}${body ? ` (${body})` : ""}`);
          continue;
        }

        const raw = Buffer.from(await res.arrayBuffer());
        console.log(
          `[upstox] downloaded ${(raw.length / 1e6).toFixed(1)} MB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, decompressing …`,
        );

        const rows = await parseInstrumentPayload(raw);
        console.log(`[upstox] parsed ${rows.length.toLocaleString()} instrument rows`);
        return rows;
      } catch (err) {
        failures.push(`${url} → ${(err as Error).message}`);
      }
    }

    const message =
      `Could not obtain the Upstox contract list. Tried:\n  ${failures.join("\n  ")}\n` +
      `If these are 403s, the download is being blocked rather than your token being wrong — ` +
      `set UPSTOX_INSTRUMENTS_URL to a reachable copy of the instrument file.`;

    // Carry the HTTP status through so the caller's retry policy still classifies this
    // correctly: a 429/503 stays retryable, while a 403 is not retried pointlessly.
    // Flattening to a bare Error would lose that and mis-handle both directions.
    throw lastStatus === undefined ? new Error(message) : new HttpError(lastStatus, message);
  }

  /** Same-day cached contract list, or null when absent/stale/unreadable. */
  private readDiskCache(): OptionInstrument[] | null {
    try {
      const raw = fs.readFileSync(path.join(appDir(), INSTRUMENTS_CACHE_FILE), "utf-8");
      const parsed = JSON.parse(raw) as { savedOn: string; instruments: OptionInstrument[] };
      // Contracts expire and new strikes list daily, so only same-session cache is valid.
      if (parsed.savedOn !== currentSessionDate()) return null;
      return Array.isArray(parsed.instruments) && parsed.instruments.length > 0
        ? parsed.instruments
        : null;
    } catch {
      return null;
    }
  }

  private writeDiskCache(instruments: OptionInstrument[]): void {
    try {
      fs.writeFileSync(
        path.join(appDir(), INSTRUMENTS_CACHE_FILE),
        JSON.stringify({ savedOn: currentSessionDate(), instruments }),
      );
    } catch {
      // A read-only folder just means no caching; not worth failing the scan over.
    }
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
    for (const [key, q] of Object.entries(payload.data ?? {})) {
      // Upstox omits or nulls fields for contracts that have not traded today, which is
      // the norm across the far-OTM strikes in the full F&O universe. Reading through a
      // null ohlc used to throw and take the whole 500-contract batch down with it, so
      // every field is read defensively and unusable rows are skipped instead.
      if (!q) continue;

      // The response is keyed by a symbol form; instrument_token is the id we requested.
      const token = q.instrument_token ?? key;
      const ohlc = q.ohlc ?? null;
      const open = num(ohlc?.open);
      const low = num(ohlc?.low);
      const reportedOi = num(q.oi);
      const oi = reportedOi ?? 0;

      // Seed the change-in-OI baseline before the untraded check below, so a contract
      // that first trades mid-session anchors to its pre-trade OI rather than its
      // post-trade OI. Only seed from a genuinely reported figure: treating an absent
      // oi as 0 would fix the baseline at zero and later report the contract's entire
      // open interest as if it were the day's change.
      if (reportedOi !== null && !this.oiBaseline.has(token)) {
        this.oiBaseline.set(token, reportedOi);
      }
      const baseline = this.oiBaseline.get(token) ?? oi;

      // No open/low means the contract has not traded this session: it cannot satisfy
      // Open = Low, so there is nothing to report and nothing to warn about.
      if (open === null || low === null) continue;

      out.set(token, {
        instrumentToken: token,
        open,
        high: num(ohlc?.high) ?? open,
        low,
        close: num(ohlc?.close) ?? open,
        ltp: num(q.last_price) ?? open,
        volume: num(q.volume) ?? 0,
        oi,
        changeInOi: oi - baseline,
        timestamp: this.parseTimestamp(q.timestamp ?? q.last_trade_time),
      });
    }
    return out;
  }

  private parseTimestamp(raw: number | string | null | undefined): Date {
    if (raw === undefined || raw === null) return new Date();
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
