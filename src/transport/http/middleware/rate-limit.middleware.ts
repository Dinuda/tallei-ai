import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { incrementWithTtl } from "../../../infrastructure/cache/redis-cache.js";
import { setRequestTimingField } from "../../../observability/request-timing.js";

interface RateLimitOptions {
  namespace: string;
  windowSeconds: number;
  maxRequests: number;
}

interface LocalRateLimitEntry {
  count: number;
  exp: number;
}

const LOCAL_RATE_LIMIT_SAMPLE_RATIO = 0.8;
const localRateLimit = new Map<string, LocalRateLimitEntry>();

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

function cleanupLocalRateLimit(key: string): void {
  const cached = localRateLimit.get(key);
  if (!cached) return;
  if (cached.exp <= Date.now()) {
    localRateLimit.delete(key);
  }
}

function canUseLocalSampling(options: RateLimitOptions): boolean {
  return options.namespace === "mcp";
}

function tryLocalSample(key: string, maxRequests: number): number | null {
  cleanupLocalRateLimit(key);
  const cached = localRateLimit.get(key);
  if (!cached) return null;

  const threshold = Math.max(1, Math.floor(maxRequests * LOCAL_RATE_LIMIT_SAMPLE_RATIO));
  const next = cached.count + 1;
  if (next > threshold) {
    return null;
  }

  cached.count = next;
  localRateLimit.set(key, cached);
  return next;
}

function syncLocalSample(key: string, count: number, ttlSeconds: number): void {
  localRateLimit.set(key, {
    count,
    exp: Date.now() + ttlSeconds * 1000,
  });
}

function isRecallRequest(req: Request): boolean {
  const path = (req.originalUrl || req.url || "").split("?")[0];
  if (path.endsWith("/actions/recall")) return true;
  if (!path.startsWith("/mcp")) return false;

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  if (body?.method !== "tools/call") return false;
  const params = body.params && typeof body.params === "object"
    ? (body.params as Record<string, unknown>)
    : null;
  const toolName = typeof params?.name === "string" ? params.name : "";
  return toolName === "recall_memories" || toolName === "recall_memories_v2";
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startedAt = process.hrtime.bigint();
    const windowBucket = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const ttlSeconds = options.windowSeconds + 2;
    const key = [
      "rl",
      options.namespace,
      windowBucket,
      requestIp(req),
      authFingerprint(req),
    ].join(":");

    let source: "redis" | "local_sampled" = "redis";
    let count: number;
    if (canUseLocalSampling(options)) {
      const sampled = tryLocalSample(key, options.maxRequests);
      if (sampled !== null) {
        source = "local_sampled";
        count = sampled;
      } else {
        count = await incrementWithTtl(key, ttlSeconds);
        syncLocalSample(key, count, ttlSeconds);
      }
    } else {
      count = await incrementWithTtl(key, ttlSeconds);
    }

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    setRequestTimingField("rate_limit_ms", elapsedMs);
    setRequestTimingField("rate_limit_namespace", options.namespace);
    setRequestTimingField("rate_limit_source", source);
    if (isRecallRequest(req)) {
      setRequestTimingField("recall_rate_limit_ms", elapsedMs);
    }

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
