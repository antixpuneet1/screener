export type OptionType = "CE" | "PE";

/** One tradable F&O option contract (a single strike/expiry/CE-PE combination). */
export interface OptionInstrument {
  /** Provider-native instrument identifier, used to request quotes. */
  instrumentToken: string;
  /** Underlying F&O stock/index symbol, e.g. "RELIANCE". */
  underlying: string;
  optionType: OptionType;
  strike: number;
  /** ISO date (YYYY-MM-DD) of contract expiry. */
  expiry: string;
  /** Exchange trading symbol, e.g. "RELIANCE24DEC2980CE". */
  tradingSymbol: string;
  lotSize: number;
}

/** A live quote snapshot for one option instrument. */
export interface OptionQuote {
  instrumentToken: string;
  open: number;
  high: number;
  low: number;
  close: number;
  ltp: number;
  volume: number;
  oi: number;
  /** Change in open interest vs. the previous session's closing OI. */
  changeInOi: number;
  /** Exact timestamp the quote/data point represents, as reported by the data source. */
  timestamp: Date;
}

export interface ScreenerHit {
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiry: string;
  tradingSymbol: string;
  open: number;
  low: number;
  ltp: number;
  volume: number;
  oi: number;
  changeInOi: number;
  timestamp: string;
  /** True the first cycle this contract is detected as O=L in the current trading session. */
  isNew: boolean;
  /** Milliseconds since epoch when this contract was first detected as O=L today. */
  firstDetectedAt: number;
}

/**
 * A live market-data source. Implementations wrap a specific broker/vendor API
 * (Kite Connect, a demo/mock feed, or any future provider) behind this contract
 * so the screener logic never depends on a specific vendor.
 */
export interface DataProvider {
  readonly name: string;

  /**
   * Returns the full, current NSE F&O option universe (every underlying stock/index
   * that has listed options, across all strikes and expiries). Implementations should
   * derive this from the provider's own live instrument master so the list never goes stale
   * or needs to be hardcoded.
   */
  getOptionInstruments(): Promise<OptionInstrument[]>;

  /**
   * Fetches live quotes for a batch of instruments. Batch size is controlled by the
   * caller to respect provider-specific request limits.
   */
  getQuotes(instrumentTokens: string[]): Promise<Map<string, OptionQuote>>;

  /** Maximum instruments allowed in a single getQuotes() call for this provider. */
  readonly maxQuoteBatchSize: number;

  /** Requests per second this provider's API allows for quote calls. */
  readonly quoteRateLimitPerSecond: number;

  /**
   * Every rolling limit the provider enforces, not just the per-second one. Real broker
   * APIs cap longer windows too (Upstox: 25/sec, 250/min, 1000/30min), and on a
   * full-universe scan those longer windows are what actually bind. Optional: providers
   * that only have a per-second cap can omit it.
   */
  readonly quoteRateWindows?: ReadonlyArray<{ limit: number; windowMs: number }>;

  /** Releases any timers/resources. Called when the provider is replaced. */
  dispose?(): void;
}
