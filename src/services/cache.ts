import { createClient } from "redis";
import { config } from "../config.js";

let redisClient: ReturnType<typeof createClient> | null = null;
let redisInitPromise: Promise<ReturnType<typeof createClient> | null> | null = null;

function isRedisConfigured(): boolean {
  return Boolean(config.redisUrl);
}

async function initRedis(): Promise<ReturnType<typeof createClient> | null> {
  if (!isRedisConfigured()) return null;

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (redisInitPromise) {
    return redisInitPromise;
  }

  redisInitPromise = (async () => {
    const client = createClient({ url: config.redisUrl });
    client.on("error", (error) => {
      if (config.nodeEnv !== "production") {
        console.error("[redis] client error", error);
      }
    });

    try {
      await client.connect();
      redisClient = client;
      return client;
    } catch (error) {
      if (config.nodeEnv !== "production") {
        console.error("[redis] connection failed; falling back to no-cache mode", error);
      }
      redisClient = null;
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
    const value = await client.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function setCacheJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const client = await initRedis();
  if (!client) return;

  try {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch {
    // Best-effort cache.
  }
}

export async function deleteCacheKey(key: string): Promise<void> {
  const client = await initRedis();
  if (!client) return;
  try {
    await client.del(key);
  } catch {
    // Best-effort cache.
  }
}

export async function incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const client = await initRedis();
  if (!client) return 1;

  try {
    const value = await client.incr(key);
    if (value === 1) {
      await client.expire(key, ttlSeconds);
    }
    return value;
  } catch {
    return 1;
  }
}
