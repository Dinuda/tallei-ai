import { createHash } from "node:crypto";
import { pool } from "../db/index.js";
import type { OnboardingState } from "./claudeOnboarding.js";

type CachedState = Exclude<OnboardingState, "queued">;

type CacheRow = {
  state: string;
  error_signature: string;
  instruction: string;
};

function sanitizeError(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function signature(state: CachedState, error: string): string {
  return createHash("sha256").update(`${state}|${sanitizeError(error)}`).digest("hex");
}

class BrowserFallbackCache {
  private readonly memory = new Map<string, string>();

  private key(state: CachedState, error: string): string {
    return `${state}:${signature(state, error)}`;
  }

  async get(state: CachedState, error: string): Promise<{ instruction: string; signature: string } | null> {
    const sig = signature(state, error);
    const memKey = `${state}:${sig}`;
    const fromMemory = this.memory.get(memKey);
    if (fromMemory) {
      return { instruction: fromMemory, signature: sig };
    }

    const result = await pool.query<CacheRow>(
      `SELECT state, error_signature, instruction
       FROM browser_onboarding_fallback_cache
       WHERE state = $1 AND error_signature = $2
       LIMIT 1`,
      [state, sig]
    );

    const row = result.rows[0];
    if (!row?.instruction) return null;
    this.memory.set(memKey, row.instruction);
    return { instruction: row.instruction, signature: sig };
  }

  async put(state: CachedState, error: string, instruction: string): Promise<{ signature: string }> {
    const sig = signature(state, error);
    const memKey = `${state}:${sig}`;
    this.memory.set(memKey, instruction);

    await pool.query(
      `INSERT INTO browser_onboarding_fallback_cache (
         state, error_signature, instruction, hits, created_at, updated_at
       )
       VALUES ($1, $2, $3, 0, NOW(), NOW())
       ON CONFLICT (state, error_signature)
       DO UPDATE SET
         instruction = EXCLUDED.instruction,
         updated_at = NOW()`,
      [state, sig, instruction]
    );

    return { signature: sig };
  }

  async recordHit(state: CachedState, signatureValue: string): Promise<void> {
    const key = `${state}:${signatureValue}`;
    if (this.memory.has(key)) {
      // in-memory hit already captured; still track persistence for observability.
    }
    await pool.query(
      `UPDATE browser_onboarding_fallback_cache
       SET hits = hits + 1,
           last_hit_at = NOW(),
           updated_at = NOW()
       WHERE state = $1 AND error_signature = $2`,
      [state, signatureValue]
    );
  }
}

export const browserFallbackCache = new BrowserFallbackCache();
