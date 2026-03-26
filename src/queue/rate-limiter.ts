export interface RateLimiterConfig {
  /** Maximum requests per second (token refill rate) */
  maxRPS: number;
  /** Maximum concurrent in-flight requests */
  maxConcurrent: number;
  /** Window in ms for RPM tracking (default 60000) */
  windowMs?: number;
  /** Maximum backoff cap in ms (default 120000) */
  maxBackoffMs?: number;
  /** Window in ms to detect repeated 429s for adaptive backoff (default 30000) */
  adaptiveWindowMs?: number;
}

export interface RateLimiterStatus {
  availableTokens: number;
  currentConcurrent: number;
  isBackingOff: boolean;
  backoffRemainingMs: number;
}

export class RateLimiter {
  private readonly maxRPS: number;
  private readonly maxConcurrent: number;
  private readonly maxBackoffMs: number;
  private readonly adaptiveWindowMs: number;

  private tokens: number;
  private lastRefillTime: number;
  private currentConcurrent = 0;

  private backoffUntil = 0;
  private backoffHistory: number[] = [];
  private lastBackoffDuration = 0;

  private waitQueue: Array<() => void> = [];
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimiterConfig) {
    this.maxRPS = config.maxRPS;
    this.maxConcurrent = config.maxConcurrent;
    this.maxBackoffMs = config.maxBackoffMs ?? 120_000;
    this.adaptiveWindowMs = config.adaptiveWindowMs ?? 30_000;

    this.tokens = config.maxRPS;
    this.lastRefillTime = Date.now();

    // Refill tokens periodically
    const refillIntervalMs = 1000 / this.maxRPS;
    this.refillTimer = setInterval(() => {
      this._refillTokens();
      this._drainWaitQueue();
    }, Math.max(refillIntervalMs, 50));
  }

  /**
   * Blocks until a token is available AND concurrent count is below max.
   */
  async acquire(): Promise<void> {
    while (!this._canAcquire()) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    this.tokens--;
    this.currentConcurrent++;
  }

  /**
   * Decrements concurrent count after a request completes.
   */
  release(): void {
    if (this.currentConcurrent > 0) {
      this.currentConcurrent--;
    }
    this._drainWaitQueue();
  }

  /**
   * Pauses all acquisitions for the specified duration.
   * Applies adaptive backoff on repeated calls within the adaptive window.
   */
  backoff(retryAfterMs: number): void {
    const now = Date.now();

    // Prune old backoff history
    this.backoffHistory = this.backoffHistory.filter(
      (t) => now - t < this.adaptiveWindowMs
    );
    this.backoffHistory.push(now);

    let duration = retryAfterMs;

    // Adaptive: if repeated 429s in the window, double the duration
    if (this.backoffHistory.length > 1 && this.lastBackoffDuration > 0) {
      duration = Math.max(duration, this.lastBackoffDuration * 2);
    }

    // Cap at max
    duration = Math.min(duration, this.maxBackoffMs);
    this.lastBackoffDuration = duration;

    const backoffEnd = now + duration;
    if (backoffEnd > this.backoffUntil) {
      this.backoffUntil = backoffEnd;
    }

    // Schedule wake-up after backoff expires
    setTimeout(() => {
      this._drainWaitQueue();
    }, duration);
  }

  /**
   * Returns current status for monitoring.
   */
  getStatus(): RateLimiterStatus {
    this._refillTokens();
    const now = Date.now();
    const remaining = Math.max(0, this.backoffUntil - now);
    return {
      availableTokens: Math.floor(this.tokens),
      currentConcurrent: this.currentConcurrent,
      isBackingOff: now < this.backoffUntil,
      backoffRemainingMs: remaining,
    };
  }

  /**
   * Stops the internal refill timer. Call when done with the limiter.
   */
  destroy(): void {
    if (this.refillTimer !== null) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    // Wake all waiters so they don't hang forever
    for (const resolve of this.waitQueue) {
      resolve();
    }
    this.waitQueue = [];
  }

  private _canAcquire(): boolean {
    this._refillTokens();
    const now = Date.now();
    if (now < this.backoffUntil) return false;
    if (this.currentConcurrent >= this.maxConcurrent) return false;
    if (this.tokens < 1) return false;
    return true;
  }

  private _refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd = (elapsed / 1000) * this.maxRPS;
    this.tokens = Math.min(this.maxRPS, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  private _drainWaitQueue(): void {
    while (this.waitQueue.length > 0 && this._canAcquire()) {
      const resolve = this.waitQueue.shift();
      if (resolve) resolve();
    }
  }
}

