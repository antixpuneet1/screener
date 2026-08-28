import type { DataProvider, OptionInstrument, OptionQuote, ScreenerHit } from "../types.js";
import { RateLimiter, withRetry } from "../rateLimiter.js";
import { config } from "../config.js";
import { isMarketOpen } from "../marketHours.js";
import { ScreenerState } from "./state.js";

const OPEN_EQ_LOW_EPSILON = 0.001;

export interface ScanCycleResult {
  hits: ScreenerHit[];
  scannedContracts: number;
  cycleStartedAt: string;
  cycleDurationMs: number;
  errors: string[];
  marketOpen: boolean;
}

/** Emitted as a cycle runs. A full-universe scan takes minutes at real F&O size, so
 *  without this the app looks frozen until the first cycle finally lands. */
export interface ScanProgress {
  phase: "loading-instruments" | "scanning" | "idle";
  totalContracts: number;
  quotedContracts: number;
  batchesDone: number;
  batchesTotal: number;
  errors: number;
  /** Human-readable detail, e.g. "downloading contract list (12.4 MB)". Without it a
   *  slow instrument download is indistinguishable from a hang. */
  detail?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Core screener engine: provider-agnostic. Repeatedly pulls the full F&O option
 * universe from whatever DataProvider is configured, fetches live quotes in
 * rate-limited batches, and detects Open == Low contracts for the current session.
 */
export class Scanner {
  private readonly rateLimiter: RateLimiter;
  private readonly state = new ScreenerState();
  private instrumentsByToken = new Map<string, OptionInstrument>();

  constructor(private readonly provider: DataProvider) {
    // Honour every window the provider declares, so long-window caps throttle the scan
    // instead of letting it run headlong into 429s.
    this.rateLimiter = new RateLimiter(
      provider.quoteRateWindows && provider.quoteRateWindows.length > 0
        ? [...provider.quoteRateWindows]
        : provider.quoteRateLimitPerSecond,
    );
  }

  /** Releases the rate limiter's timer. Call when replacing this Scanner. */
  dispose(): void {
    this.rateLimiter.dispose();
  }

  async runCycle(onProgress?: (p: ScanProgress) => void): Promise<ScanCycleResult> {
    const cycleStart = Date.now();
    const marketOpen = isMarketOpen();
    const errors: string[] = [];
    const report = (p: ScanProgress) => {
      try {
        onProgress?.(p);
      } catch {
        // progress reporting must never break a scan
      }
    };

    if (!marketOpen) {
      return {
        hits: [],
        scannedContracts: 0,
        cycleStartedAt: new Date(cycleStart).toISOString(),
        cycleDurationMs: 0,
        errors,
        marketOpen,
      };
    }

    let instruments: OptionInstrument[];
    report({
      phase: "loading-instruments",
      totalContracts: 0,
      quotedContracts: 0,
      batchesDone: 0,
      batchesTotal: 0,
      errors: 0,
      detail: "downloading contract list (first run can take a minute)",
    });
    try {
      instruments = await withRetry(() => this.provider.getOptionInstruments(), {
        maxRetries: config.maxRetries,
      });
    } catch (err) {
      errors.push(`Failed to load instrument universe: ${(err as Error).message}`);
      return {
        hits: [],
        scannedContracts: 0,
        cycleStartedAt: new Date(cycleStart).toISOString(),
        cycleDurationMs: Date.now() - cycleStart,
        errors,
        marketOpen,
      };
    }

    this.instrumentsByToken = new Map(instruments.map((i) => [i.instrumentToken, i]));
    const instrumentsBySymbol = new Map(instruments.map((i) => [i.tradingSymbol, i]));
    const batches = chunk(instruments, this.provider.maxQuoteBatchSize);
    const activeKeys = new Set<string>();
    const quotesByToken = new Map<string, OptionQuote>();

    let batchesDone = 0;
    for (const batch of batches) {
      await this.rateLimiter.acquire();
      try {
        const quotes = await withRetry(
          () => this.provider.getQuotes(batch.map((i) => i.instrumentToken)),
          { maxRetries: config.maxRetries },
        );
        for (const [token, q] of quotes) quotesByToken.set(token, q);
      } catch (err) {
        errors.push(
          `Quote batch failed (${batch.length} contracts, e.g. ${batch[0]?.tradingSymbol}): ${(err as Error).message}`,
        );
      }
      batchesDone++;
      report({
        phase: "scanning",
        totalContracts: instruments.length,
        quotedContracts: quotesByToken.size,
        batchesDone,
        batchesTotal: batches.length,
        errors: errors.length,
      });
    }

    for (const [token, quote] of quotesByToken) {
      const instrument = this.instrumentsByToken.get(token);
      if (!instrument) continue;
      // A zero open means the contract hasn't traded yet today — not a real O=L signal.
      if (quote.open > 0 && Math.abs(quote.open - quote.low) < OPEN_EQ_LOW_EPSILON) {
        activeKeys.add(instrument.tradingSymbol);
      }
    }

    const hits = this.state.applyCycle(activeKeys, (tradingSymbol) => {
      const instrument = instrumentsBySymbol.get(tradingSymbol)!;
      const quote = quotesByToken.get(instrument.instrumentToken)!;
      return {
        underlying: instrument.underlying,
        optionType: instrument.optionType,
        strike: instrument.strike,
        expiry: instrument.expiry,
        tradingSymbol: instrument.tradingSymbol,
        open: quote.open,
        low: quote.low,
        ltp: quote.ltp,
        volume: quote.volume,
        oi: quote.oi,
        changeInOi: quote.changeInOi,
        timestamp: quote.timestamp.toISOString(),
      };
    });

    return {
      hits,
      scannedContracts: instruments.length,
      cycleStartedAt: new Date(cycleStart).toISOString(),
      cycleDurationMs: Date.now() - cycleStart,
      errors,
      marketOpen,
    };
  }
}
