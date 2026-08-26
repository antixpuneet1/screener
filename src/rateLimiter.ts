/**
 * Simple token-bucket rate limiter plus retry-with-backoff helper, shared by
 * every DataProvider so provider-specific API limits are respected uniformly.
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private readonly maxTokens: number;
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly ratePerSecond: number) {
    this.maxTokens = Math.max(1, ratePerSecond);
    this.tokens = this.maxTokens;
    this.timer = setInterval(() => {
      this.tokens = this.maxTokens;
      this.drain();
    }, 1000);
    this.timer.unref?.();
  }

  private drain(): void {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens--;
      const next = this.queue.shift();
      next?.();
    }
  }

  /** Resolves once a slot under the rate limit is available. */
  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }
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
