/**
 * Maps deprecated env var names to canonical TALLEI_* keys.
 * Applied once at boot before loadConfig reads values.
 */
export const ENV_ALIASES: Readonly<Record<string, string>> = {
  PORT: "TALLEI_HTTP__PORT",
  DATABASE_URL: "TALLEI_DB__URL",
  DATABASE_URL_FALLBACK: "TALLEI_DB__URL_FALLBACK",
  JWT_SECRET: "TALLEI_AUTH__JWT_SECRET",
  REDIS_URL: "TALLEI_REDIS__URL",
  OPENAI_API_KEY: "TALLEI_LLM__OPENAI_API_KEY",
  NIM_API_KEY: "TALLEI_LLM__NVIDIA_API_KEY",
  MEMORY_DUAL_WRITE_ENABLED: "TALLEI_FEATURE__MEMORY_DUAL_WRITE",
  MEMORY_SHADOW_READ_ENABLED: "TALLEI_FEATURE__MEMORY_SHADOW_READ",
};

const warnedLegacyKeys = new Set<string>();

function isSet(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/** Copy legacy env values into canonical keys when canonical is unset. */
export function applyEnvAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };

  for (const [legacyKey, canonicalKey] of Object.entries(ENV_ALIASES)) {
    if (isSet(resolved[canonicalKey]) || !isSet(resolved[legacyKey])) continue;
    resolved[canonicalKey] = resolved[legacyKey]!.trim();
    if (!warnedLegacyKeys.has(legacyKey)) {
      warnedLegacyKeys.add(legacyKey);
      console.warn(
        `[config] ${legacyKey} is deprecated; use ${canonicalKey} instead.`,
      );
    }
  }

  if (!isSet(resolved.TALLEI_QDRANT__TIMEOUT_MS) && isSet(resolved.QDRANT_TIMEOUT_SECONDS)) {
    const seconds = Number.parseInt(resolved.QDRANT_TIMEOUT_SECONDS!.trim(), 10);
    if (!Number.isNaN(seconds)) {
      resolved.TALLEI_QDRANT__TIMEOUT_MS = String(seconds * 1000);
      if (!warnedLegacyKeys.has("QDRANT_TIMEOUT_SECONDS")) {
        warnedLegacyKeys.add("QDRANT_TIMEOUT_SECONDS");
        console.warn("[config] QDRANT_TIMEOUT_SECONDS is deprecated; use TALLEI_QDRANT__TIMEOUT_MS instead.");
      }
    }
  }

  return resolved;
}

/** @internal test helper */
export function resetEnvAliasWarnings(): void {
  warnedLegacyKeys.clear();
}
