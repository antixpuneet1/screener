/** One rolling limit, e.g. { limit: 250, windowMs: 60_000 } for "250 per minute". */
export interface RateWindow {
  limit: number;
  windowMs: number;
}

/**
 * Rate limiter enforcing several rolling windows at once, plus a retry-with-backoff
 * helper, shared by every DataProvider so vendor limits are respected uniformly.
 *
 * A single per-second bucket is not enough for a real broker API: Upstox allows 25/sec
 * but also 250/min and 1000/30min, and a full F&O scan is large enough that the longer
 * windows bind first. Honouring only the per-second rate sails through the per-minute
 * cap and every subsequent request is rejected with 429. Requests here wait for a slot
 * in *every* window instead, so the caller is throttled rather than rejected.
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  /** Timestamps of granted requests, newest last; trimmed to the longest window. */
  private history: number[] = [];
  private readonly windows: RateWindow[];
  private readonly longestWindowMs: number;
  private timer: ReturnType<typeof setInterval>;

  constructor(windows: number | RateWindow[]) {
    // A bare number keeps the old "requests per second" form working.
    this.windows = typeof windows === "number"
      ? [{ limit: Math.max(1, windows), windowMs: 1000 }]
      : windows.filter((w) => w.limit > 0 && w.windowMs > 0);
    if (this.windows.length === 0) this.windows = [{ limit: 1, windowMs: 1000 }];
    this.longestWindowMs = Math.max(...this.windows.map((w) => w.windowMs));

    // Re-check periodically: capacity frees up as old timestamps age out of a window,
    // which is time-based rather than event-based.
    this.timer = setInterval(() => this.drain(), 250);
    this.timer.unref?.();
  }

  /** Milliseconds until a slot frees up, or 0 if one is available now. */
  private waitTimeMs(now: number): number {
    let wait = 0;
    for (const w of this.windows) {
      const cutoff = now - w.windowMs;
      const usedInWindow = this.history.length - lowerBound(this.history, cutoff);
      if (usedInWindow >= w.limit) {
        // The oldest request inside this window must age out before another is allowed.
        const oldestInWindow = this.history[this.history.length - w.limit];
        wait = Math.max(wait, oldestInWindow + w.windowMs - now);
      }
    }
    return wait;
  }

  private drain(): void {
    const now = Date.now();
    if (this.history.length > 0) {
      const cutoff = now - this.longestWindowMs;
      const firstKept = lowerBound(this.history, cutoff);
      if (firstKept > 0) this.history = this.history.slice(firstKept);
    }

    while (this.queue.length > 0 && this.waitTimeMs(Date.now()) === 0) {
      this.history.push(Date.now());
      this.queue.shift()?.();
    }
  }

  /** Resolves once a slot is available under every configured window. */
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  /** Stops the internal timer. Call when discarding a limiter — the app rebuilds its
   *  provider (and limiter) on every settings save, so without this the timers pile up. */
  dispose(): void {
    clearInterval(this.timer);
    this.queue = [];
  }
}

/** Index of the first element >= value, in an ascending array. */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
}

export function isRateLimitOrTransientError(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  const message = String((err as Error)?.message ?? err ?? "");
  return /timeout|ECONNRESET|ETIMEDOUT|network/i.test(message);
}

/** Retries `fn` with exponential backoff + jitter on transient/rate-limit errors. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { maxRetries, baseDelayMs = 500, isRetryable = isRateLimitOrTransientError } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryable(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
