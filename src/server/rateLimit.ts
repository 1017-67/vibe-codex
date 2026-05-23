import { Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  check(key: string, now = Date.now()): RateLimitResult {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    bucket.count += 1;
    if (bucket.count <= this.limit) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  cleanup(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export function sendRateLimited(res: Response, result: RateLimitResult) {
  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again later.", details: { retryAfterSeconds: result.retryAfterSeconds } } });
}
