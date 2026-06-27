import { createHash } from "crypto";

import { config } from "../../config/index.js";

export type LlmKeyPoolName = "opencode" | "openai";

const rateLimitedUntilMs = new Map<string, number>();

function poolKey(pool: LlmKeyPoolName, slot: number): string {
  return `${pool}:${slot}`;
}

function stableUserSlot(userId: string, slotCount: number): number {
  const digest = createHash("sha256").update(userId).digest();
  return digest.readUInt32BE(0) % slotCount;
}

export function parseRetryAfterMs(header: string | null): number {
  if (!header) return 60_000;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return 60_000;
}

export class LlmApiKeyPool {
  constructor(private readonly keys: readonly string[]) {}

  get size(): number {
    return this.keys.length;
  }

  getKey(slot: number): string {
    const key = this.keys[slot];
    if (!key) throw new Error(`LLM API key slot ${slot} is not configured`);
    return key;
  }

  pickSlot(userId?: string): number {
    if (this.keys.length === 0) throw new Error("No LLM API keys configured");
    if (this.keys.length === 1 || !userId?.trim()) return 0;
    return stableUserSlot(userId.trim(), this.keys.length);
  }

  pickKey(userId?: string): string {
    return this.getKey(this.pickSlot(userId));
  }

  isRateLimited(pool: LlmKeyPoolName, slot: number, nowMs = Date.now()): boolean {
    const until = rateLimitedUntilMs.get(poolKey(pool, slot));
    return until != null && until > nowMs;
  }

  markRateLimited(pool: LlmKeyPoolName, slot: number, cooldownMs: number): void {
    rateLimitedUntilMs.set(poolKey(pool, slot), Date.now() + Math.max(1_000, cooldownMs));
  }

  pickAvailableSlot(
    pool: LlmKeyPoolName,
    userId: string | undefined,
    excluded: ReadonlySet<number>,
    nowMs = Date.now(),
  ): number {
    const preferred = this.pickSlot(userId);
    if (!excluded.has(preferred) && !this.isRateLimited(pool, preferred, nowMs)) {
      return preferred;
    }
    for (let slot = 0; slot < this.keys.length; slot += 1) {
      if (excluded.has(slot)) continue;
      if (!this.isRateLimited(pool, slot, nowMs)) return slot;
    }
    return -1;
  }
}

let openCodePool: LlmApiKeyPool | null = null;
let openAiPool: LlmApiKeyPool | null = null;

export function getOpenCodeApiKeyPool(): LlmApiKeyPool {
  if (!openCodePool) {
    openCodePool = new LlmApiKeyPool(config.opencodeApiKeys);
  }
  return openCodePool;
}

export function getOpenAiApiKeyPool(): LlmApiKeyPool {
  if (!openAiPool) {
    openAiPool = new LlmApiKeyPool(config.openaiApiKeys);
  }
  return openAiPool;
}

/** Reset pools — for tests only. */
export function resetLlmApiKeyPoolsForTests(): void {
  openCodePool = null;
  openAiPool = null;
  rateLimitedUntilMs.clear();
}

export function createPooledLlmFetch(
  pool: LlmApiKeyPool,
  poolName: LlmKeyPoolName,
  userId?: string,
): typeof fetch {
  return async (input, init) => {
    const tried = new Set<number>();
    let lastResponse: Response | undefined;
    let slot = pool.pickAvailableSlot(poolName, userId, tried);

    while (slot >= 0) {
      tried.add(slot);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${pool.getKey(slot)}`);
      const response = await globalThis.fetch(input, { ...init, headers });
      if (response.status !== 429) return response;

      lastResponse = response;
      pool.markRateLimited(poolName, slot, parseRetryAfterMs(response.headers.get("retry-after")));
      slot = pool.pickAvailableSlot(poolName, userId, tried);
    }

    return lastResponse ?? new Response("All LLM API keys are rate limited", { status: 429 });
  };
}
