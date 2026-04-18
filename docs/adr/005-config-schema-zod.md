# ADR-005 — Config schema + zod validation

**Status**: Accepted  
**Date**: 2026-04-18

## Context

The original `src/config.ts` accessed `process.env.*` inline at call sites across the codebase. Missing or malformed env vars caused runtime NaN, `undefined` comparisons, and cryptic errors deep inside request handlers — often only discovered under production load.

## Decision

Config is parsed once at boot in `src/config/load.ts` using zod schemas grouped by concern:

```
http        TALLEI_HTTP__PORT, TALLEI_HTTP__TRUST_PROXY
db          TALLEI_DB__URL, TALLEI_DB__URL_FALLBACK
llm         TALLEI_LLM__PROVIDER, TALLEI_LLM__OPENAI_API_KEY, TALLEI_LLM__OPENAI_BASE_URL,
            TALLEI_LLM__CHAT_MODEL, TALLEI_LLM__EMBED_MODEL
qdrant      TALLEI_QDRANT__URL, TALLEI_QDRANT__API_KEY, TALLEI_QDRANT__COLLECTION
redis       TALLEI_REDIS__URL, TALLEI_REDIS__FAILURE_COOLDOWN_MS
auth        TALLEI_AUTH__JWT_SECRET, TALLEI_AUTH__GOOGLE_CLIENT_ID, ...
billing     TALLEI_BILLING__LEMON_SQUEEZY_API_KEY, ...
features    TALLEI_FEATURE__GRAPH_EXTRACTION_ENABLED, ...
resilience  TALLEI_RESILIENCE__CHAT_TIMEOUT_MS, ...
```

`loadConfig(env)` throws an aggregated error listing every invalid field before the server binds to a port. There is no "partial start". Helper utilities (`readBooleanEnv`, `readIntEnv`, `requireEnv`, etc.) live in `src/config/schema.ts` and are the **only** way to read env vars — `process.env.*` is banned outside `config/`.

## Migration

Old env var names remain readable via dual-read until one release after announcement:

```typescript
const apiKey =
  env.TALLEI_LLM__OPENAI_API_KEY ??
  env.OPENAI_API_KEY;  // deprecated — remove after v2.x
```

A deprecation warning is emitted at boot if an old name is used without the new one.

## Consequences

- Boot failure is immediate and descriptive when any required env var is missing.
- All config accesses are typed (`Config` interface exported from `config/`).
- `process.env.*` outside `config/` is a lint error (`no-process-env` rule).
- Config is injectable in tests — pass `loadConfig({ ...defaults, TALLEI_LLM__PROVIDER: "ollama" })`.
