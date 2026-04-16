import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { incrementWithTtl } from "../services/cache.js";
import { setRequestTimingField } from "../services/requestTiming.js";

interface RateLimitOptions {
  namespace: string;
  windowSeconds: number;
  maxRequests: number;
}

function requestIp(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return forwardedFor[0].split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function authFingerprint(req: Request): string {
  const auth = req.headers.authorization || "";
  if (auth.length === 0) return "no-auth";
  return createHash("sha256").update(auth).digest("hex").slice(0, 16);
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startedAt = process.hrtime.bigint();
    const windowBucket = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const key = [
      "rl",
      options.namespace,
      windowBucket,
      requestIp(req),
      authFingerprint(req),
    ].join(":");

    const count = await incrementWithTtl(key, options.windowSeconds + 2);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    setRequestTimingField("rate_limit_ms", elapsedMs);
    setRequestTimingField("rate_limit_namespace", options.namespace);

    if (count > options.maxRequests) {
      res.status(429).json({
        error: "Rate limit exceeded",
        namespace: options.namespace,
        retryAfterSeconds: options.windowSeconds,
      });
      return;
    }

    next();
  };
}
