import { RateLimiter, type RateLimiterConfig } from './rate-limiter.js';

/**
 * Well-known provider names that can be rate-limited.
 */
export type ProviderName =
  | 'grok-video'
  | 'grok-image'
  | 'nano-banana'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'veo'
  | 'ltx'
  | 'reve';

/**
 * Default rate-limiter configs per provider.
 * Each can be overridden by env vars:
 *   RATE_LIMIT_{PROVIDER}_RPS  (e.g. RATE_LIMIT_GROK_VIDEO_RPS)
 *   RATE_LIMIT_{PROVIDER}_CONCURRENT
 */
const DEFAULT_CONFIGS: Record<ProviderName, Pick<RateLimiterConfig, 'maxRPS' | 'maxConcurrent'>> = {
  'grok-video':  { maxRPS: 1,     maxConcurrent: 2 },
  'grok-image':  { maxRPS: 2,     maxConcurrent: 3 },
  'nano-banana': { maxRPS: 2,     maxConcurrent: 3 },
  'anthropic':   { maxRPS: 3,     maxConcurrent: 4 },
  'openai':      { maxRPS: 3,     maxConcurrent: 4 },
  'gemini':      { maxRPS: 5,     maxConcurrent: 5 },
  'veo':         { maxRPS: 0.033, maxConcurrent: 1 },  // ~1 per 30s
  'ltx':         { maxRPS: 1,     maxConcurrent: 1 },  // queue-based, one at a time
  'reve':        { maxRPS: 2,     maxConcurrent: 3 },
};

/**
 * Convert a provider name to an env-var prefix.
 * e.g. "grok-video" → "GROK_VIDEO"
 */
function envKey(provider: ProviderName): string {
  return provider.toUpperCase().replace(/-/g, '_');
}

function readEnvNumber(name: string): number | undefined {
  const val = process.env[name];
  if (val === undefined) return undefined;
  const n = parseFloat(val);
  return isNaN(n) ? undefined : n;
}

/**
 * Singleton registry of per-provider rate limiters.
 * Limiters are created lazily on first access.
 */
class RateLimiterRegistry {
  private limiters = new Map<string, RateLimiter>();

  /**
   * Get (or create) the rate limiter for a provider.
   */
  get(provider: ProviderName): RateLimiter {
    let limiter = this.limiters.get(provider);
    if (!limiter) {
      const defaults = DEFAULT_CONFIGS[provider];
      const prefix = envKey(provider);
      const maxRPS = readEnvNumber(`RATE_LIMIT_${prefix}_RPS`) ?? defaults.maxRPS;
      const maxConcurrent = readEnvNumber(`RATE_LIMIT_${prefix}_CONCURRENT`) ?? defaults.maxConcurrent;

      limiter = new RateLimiter({ maxRPS, maxConcurrent, name: provider });
      this.limiters.set(provider, limiter);
      console.log(`[rate-limiter] Created "${provider}" limiter: ${maxRPS} RPS, ${maxConcurrent} max concurrent`);
    }
    return limiter;
  }

  /**
   * Destroy all limiters (cleanup timers).
   */
  destroyAll(): void {
    for (const limiter of this.limiters.values()) {
      limiter.destroy();
    }
    this.limiters.clear();
  }
}

/** Singleton instance. */
export const rateLimiters = new RateLimiterRegistry();

