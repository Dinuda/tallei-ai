import { createClient } from "redis";
import { config } from "../config.js";

let redisClient: ReturnType<typeof createClient> | null = null;
let redisInitPromise: Promise<ReturnType<typeof createClient> | null> | null = null;
let redisDisabledUntil = 0;
let lastRedisLogAt = 0;
let lastRedisError: string | null = null;
let hasWarnedProtocolMismatch = false;

const REDIS_LOG_INTERVAL_MS = 30_000;
const INCREMENT_WITH_TTL_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
`;

type RedisMode = "online" | "cooldown" | "disabled";

export interface RedisHealthState {
  mode: RedisMode;
  lastError: string | null;
  cooldownUntilMs: number;
}

function isRedisConfigured(): boolean {
  return Boolean(config.redisUrl);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function disableRedisTemporarily(): void {
  redisDisabledUntil = Date.now() + Math.max(1_000, config.redisFailureCooldownMs);
  redisInitPromise = null;
  const current = redisClient;
  redisClient = null;
  if (current && current.isOpen) {
    void current.quit().catch(() => {});
  }
}

function shouldSkipRedis(): boolean {
  return Date.now() < redisDisabledUntil;
}

function sanitizeRedisError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown redis error");
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
}

function maybeWarnProtocolMismatch(error: unknown): void {
  if (hasWarnedProtocolMismatch || config.nodeEnv === "production") return;
  const message = sanitizeRedisError(error).toLowerCase();
  const isSslVersionMismatch =
    message.includes("err_ssl_wrong_version_number") || message.includes("wrong version number");
  if (!isSslVersionMismatch) return;

  hasWarnedProtocolMismatch = true;
  if (config.redisUrl.startsWith("rediss://")) {
    console.warn(
      "[redis] TLS handshake mismatch detected. Endpoint may be non-TLS. Try redis:// or a TLS-enabled port."
    );
    return;
  }
  if (config.redisUrl.startsWith("redis://")) {
    console.warn(
      "[redis] TLS handshake mismatch detected. Endpoint may require TLS. Try rediss:// with the provider's TLS port."
    );
  }
}

function logRedisWarning(message: string, error: unknown): void {
  lastRedisError = sanitizeRedisError(error);
  maybeWarnProtocolMismatch(error);
  if (config.nodeEnv === "production") return;
  const now = Date.now();
  if (now - lastRedisLogAt < REDIS_LOG_INTERVAL_MS) return;
  lastRedisLogAt = now;
  console.error(message, error);
}

async function initRedis(): Promise<ReturnType<typeof createClient> | null> {
  if (!isRedisConfigured()) return null;
  if (shouldSkipRedis()) return null;

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (redisInitPromise) {
    return redisInitPromise;
  }

  redisInitPromise = (async () => {
    const client = createClient({
      url: config.redisUrl,
      socket: {
        connectTimeout: config.redisConnectTimeoutMs,
        reconnectStrategy: () => false,
      },
    });
    client.on("error", (error) => {
      if (shouldSkipRedis()) return;
      logRedisWarning("[redis] client error", error);
    });

    try {
      await withTimeout(client.connect(), config.redisConnectTimeoutMs, "redis.connect");
      redisClient = client;
      lastRedisError = null;
      return client;
    } catch (error) {
      logRedisWarning("[redis] connection failed; falling back to no-cache mode", error);
      disableRedisTemporarily();
      void client.quit().catch(() => {});
      return null;
    } finally {
      redisInitPromise = null;
    }
  })();

  return redisInitPromise;
}

export async function getCacheJson<T>(key: string): Promise<T | null> {
  const client = await initRedis();
  if (!client) return null;

  try {
    const value = await withTimeout(client.get(key), config.redisCommandTimeoutMs, "redis.get");
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch {
    lastRedisError = "redis.get failed";
    disableRedisTemporarily();
    return null;
  }
}

export async function setCacheJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const client = await initRedis();
  if (!client) return;

  try {
    await withTimeout(
      client.set(key, JSON.stringify(value), { EX: ttlSeconds }),
      config.redisCommandTimeoutMs,
      "redis.set"
    );
  } catch {
    lastRedisError = "redis.set failed";
    disableRedisTemporarily();
    // Best-effort cache.
  }
}

export async function deleteCacheKey(key: string): Promise<void> {
  const client = await initRedis();
  if (!client) return;
  try {
    await withTimeout(client.del(key), config.redisCommandTimeoutMs, "redis.del");
  } catch {
    lastRedisError = "redis.del failed";
    disableRedisTemporarily();
    // Best-effort cache.
  }
}

export async function incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const client = await initRedis();
  if (!client) return 1;

  try {
    const value = await withTimeout(
      client.eval(INCREMENT_WITH_TTL_LUA, {
        keys: [key],
        arguments: [String(ttlSeconds)],
      }),
      config.redisCommandTimeoutMs,
      "redis.eval.incr_ttl"
    );
    if (typeof value !== "number") {
      throw new Error("redis.eval.incr_ttl returned non-numeric value");
    }
    return value;
  } catch {
    lastRedisError = "redis.incr_ttl failed";
    disableRedisTemporarily();
    return 1;
  }
}

export function getRedisHealthState(): RedisHealthState {
  if (!isRedisConfigured()) {
    return { mode: "disabled", lastError: null, cooldownUntilMs: 0 };
  }
  if (shouldSkipRedis()) {
    return { mode: "cooldown", lastError: lastRedisError, cooldownUntilMs: redisDisabledUntil };
  }
  if (redisClient?.isOpen) {
    return { mode: "online", lastError: null, cooldownUntilMs: 0 };
  }
  return { mode: "disabled", lastError: lastRedisError, cooldownUntilMs: 0 };
}
