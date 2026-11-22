export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface BucketEntry {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

export class InProcessRateLimiter {
  private buckets = new Map<string, BucketEntry>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;

  constructor(options: { maxAttempts: number; windowMs: number; lockoutMs?: number }) {
    this.maxAttempts = options.maxAttempts;
    this.windowMs = options.windowMs;
    this.lockoutMs = options.lockoutMs ?? options.windowMs;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const entry = this.buckets.get(key);
    if (!entry) {
      return { allowed: true, remaining: this.maxAttempts, retryAfterSeconds: 0 };
    }
    if (entry.lockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      };
    }
    if (now - entry.windowStart >= this.windowMs) {
      this.buckets.delete(key);
      return { allowed: true, remaining: this.maxAttempts, retryAfterSeconds: 0 };
    }
    const remaining = Math.max(0, this.maxAttempts - entry.count);
    return {
      allowed: remaining > 0,
      remaining,
      retryAfterSeconds: remaining > 0 ? 0 : Math.ceil((entry.windowStart + this.windowMs - now) / 1000),
    };
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const existing = this.buckets.get(key);
    if (existing && existing.lockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((existing.lockedUntil - now) / 1000),
      };
    }

    if (!existing || now - existing.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
      return { allowed: true, remaining: Math.max(0, this.maxAttempts - 1), retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > this.maxAttempts) {
      existing.lockedUntil = now + this.lockoutMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(this.lockoutMs / 1000),
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxAttempts - existing.count),
      retryAfterSeconds: 0,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export const loginRateLimiter = new InProcessRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000, // 15 minutes
  lockoutMs: 15 * 60 * 1000,
});

export const apiRateLimiter = new InProcessRateLimiter({
  maxAttempts: 240,
  windowMs: 60 * 1000, // 1 minute
  lockoutMs: 60 * 1000,
});
