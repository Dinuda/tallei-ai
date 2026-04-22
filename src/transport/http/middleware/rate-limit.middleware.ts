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
const MEMORY_API_RATE_LIMIT_SOFT_TIMEOUT_MS = 40;
const localRateLimit = new Map<string, LocalRateLimitEntry>();

function requestIp(req: Request): string {
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
  return options.namespace === "mcp" || options.namespace === "memory-api";
}

function bumpLocalCount(key: string, ttlSeconds: number): number {
  cleanupLocalRateLimit(key);
  const cached = localRateLimit.get(key);
  if (!cached) {
    localRateLimit.set(key, { count: 1, exp: Date.now() + ttlSeconds * 1000 });
    return 1;
  }
  const next = cached.count + 1;
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
  if (path.endsWith("/actions/recall_memories")) return true;
  if (!path.startsWith("/mcp")) return false;

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  if (body?.method !== "tools/call") return false;
  const params = body.params && typeof body.params === "object"
    ? (body.params as Record<string, unknown>)
    : null;
  const toolName = typeof params?.name === "string" ? params.name : "";
  return toolName === "recall_memories";
}

function shouldUseSoftTimeout(options: RateLimitOptions): boolean {
  return options.namespace === "memory-api";
}

async function incrementWithSoftTimeout(
  key: string,
  ttlSeconds: number,
  timeoutMs: number
): Promise<{ status: "ok"; count: number } | { status: "timeout" } | { status: "error" }> {
  const wrappedIncrement = incrementWithTtl(key, ttlSeconds)
    .then((count) => ({ status: "ok" as const, count }))
    .catch(() => ({ status: "error" as const }));
  const timeoutResult = new Promise<{ status: "timeout" }>((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    timer.unref?.();
  });

  return Promise.race([wrappedIncrement, timeoutResult]);
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

    let source:
      | "redis"
      | "local_bucket"
      | "redis_threshold"
      | "redis_timeout_fail_open"
      | "redis_error_fail_open" = "redis";
    let count: number;
    if (canUseLocalSampling(options)) {
      const localCount = bumpLocalCount(key, ttlSeconds);
      const threshold = Math.max(1, Math.floor(options.maxRequests * LOCAL_RATE_LIMIT_SAMPLE_RATIO));
      if (localCount <= threshold) {
        source = "local_bucket";
        count = localCount;
        void incrementWithTtl(key, ttlSeconds).catch(() => {});
      } else if (shouldUseSoftTimeout(options)) {
        source = "redis_threshold";
        const startedRedisAt = process.hrtime.bigint();
        const incrementResult = await incrementWithSoftTimeout(
          key,
          ttlSeconds,
          MEMORY_API_RATE_LIMIT_SOFT_TIMEOUT_MS
        );
        const redisMs = Number(process.hrtime.bigint() - startedRedisAt) / 1_000_000;
        setRequestTimingField("rate_limit_redis_ms", redisMs);
        if (incrementResult.status === "ok") {
          count = incrementResult.count;
          syncLocalSample(key, count, ttlSeconds);
        } else {
          source = incrementResult.status === "timeout"
            ? "redis_timeout_fail_open"
            : "redis_error_fail_open";
          setRequestTimingField("rate_limit_fail_open", true);
          count = localCount;
          syncLocalSample(key, count, ttlSeconds);
        }
      } else {
        source = "redis_threshold";
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
