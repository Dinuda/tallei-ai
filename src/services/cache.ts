import { createClient } from "redis";
import { config } from "../config.js";

let redisClient: ReturnType<typeof createClient> | null = null;
let redisInitPromise: Promise<ReturnType<typeof createClient> | null> | null = null;
let redisDisabledUntil = 0;
let lastRedisLogAt = 0;

const REDIS_LOG_INTERVAL_MS = 30_000;

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

function logRedisWarning(message: string, error: unknown): void {
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
    disableRedisTemporarily();
    // Best-effort cache.
  }
}

export async function incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const client = await initRedis();
  if (!client) return 1;

  try {
    const value = await withTimeout(client.incr(key), config.redisCommandTimeoutMs, "redis.incr");
    if (value === 1) {
      await withTimeout(client.expire(key, ttlSeconds), config.redisCommandTimeoutMs, "redis.expire");
    }
    return value;
  } catch {
    disableRedisTemporarily();
    return 1;
  }
}
