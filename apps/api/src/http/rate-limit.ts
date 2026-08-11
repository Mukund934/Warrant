import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export function rateLimit({ windowMs, max }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  return function limit(request: Request, response: Response, next: NextFunction): void {
    const now = Date.now();
    const key = request.ip ?? "unknown";
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      response
        .status(429)
        .set("retry-after", String(Math.ceil((bucket.resetAt - now) / 1000)))
        .json({
          error: "rate_limited",
          message: "too many requests from this address; this limit is per server instance",
        });
      return;
    }

    next();
  };
}
