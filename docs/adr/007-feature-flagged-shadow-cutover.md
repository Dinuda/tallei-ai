# ADR-007 — Feature-flagged shadow cutover for memory.ts extraction

**Status**: Accepted  
**Date**: 2026-04-18

## Context

`src/services/memory.ts` was the highest-risk migration target: 1015 lines containing quota enforcement, caching, dual-write, shadow-read diffing, vector operations, and fallback logic. Rewriting it in a single PR with a flag day cutover would be unrecoverable if it introduced silent drift in recall ordering, fallback shape, or quota timing.

## Decision

Each of the four primary operations was extracted independently with its own boolean feature flag:

| Flag env var | Operation |
|---|---|
| `USE_NEW_SAVE_USECASE` | `saveMemory` routes to `SaveMemoryUseCase.execute` |
| `USE_NEW_RECALL_USECASE` | `recallMemories` routes to `RecallMemoryUseCase.execute` |
| `USE_NEW_LIST_USECASE` | `listMemories` routes to `ListMemoriesUseCase.execute` |
| `USE_NEW_DELETE_USECASE` | `deleteMemory` routes to `DeleteMemoryUseCase.execute` |

All flags default to `false`. The thin routing barrel `src/services/memory.ts` reads these flags and calls either the new use case or the legacy implementation in `memory.legacy-impl.ts`.

**Cutover protocol per operation:**
1. Enable flag in staging → run for 24 h → monitor `shadow_divergence` event rate.
2. If divergence rate < 0.1% → enable flag in production.
3. Monitor recall source distribution (within ±5% of baseline) and 5xx rate (no increase) for 24 h.
4. Lock the flag on; delete the legacy code path in the next PR.

**Shadow-read** (not dual-write): when `recallV2ShadowMode` is enabled, the v1 recall also runs v2 in background and logs divergences. This is for observability only — the primary path always wins.

## Consequences

- Each flag is independently revertable in seconds (no redeploy needed for feature flag flips backed by env vars + SIGHUP).
- `memory.legacy-impl.ts` is the holding ground for legacy logic during the shadow window — it is deleted once all four flags are permanently on (Phase 5).
- The shadow-read diff log (`action: "shadow_divergence"`) provides the empirical gate for cutover.
- Phase 5 confirmed all four operations stable; `memory.legacy-impl.ts` is now the permanent home of the legacy code pending final deletion in a future cleanup sprint.
