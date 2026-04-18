# ADR-006 — Structured logging + metrics sinks

**Status**: Accepted  
**Date**: 2026-04-18

## Context

The codebase used `console.log` / `console.error` / `console.warn` throughout. Log lines were unstructured strings — impossible to query, filter by correlation ID, or feed into a metrics pipeline. The resilience layer (circuit breakers, retry counts, policy decisions) is undebuggable without structured events.

## Decision

### Logging

`src/observability/logger.ts` exports a `Logger` interface backed by a JSON-line writer. Every log line includes:
- `ts` — ISO 8601 timestamp
- `level` — `debug | info | warn | error`
- `correlationId` — propagated via `AsyncLocalStorage` (see `tracing.ts`)
- `msg` — human-readable message
- Arbitrary structured fields (spread into the root object)

In production, output is NDJSON to stdout (compatible with Datadog, CloudWatch, Loki). In development/test, output is colourised single-line text.

`console.log` / `console.error` outside of `src/patch.ts` (runtime patches) are lint errors.

### Metrics

`src/observability/metrics.ts` exports `Counter` and `Histogram` interfaces with an in-process implementation that accumulates counts in memory. The interface is designed to be wired to a Prometheus push-gateway or StatsD sink by replacing the implementation in `composition-root.ts` — no call sites change.

Key metrics emitted:
- `provider_request_total{provider,capability,status}` — success / transient / fatal / timeout
- `provider_latency_ms{provider,capability}` — histogram
- `circuit_state{provider,capability,state}` — gauge (closed/open/half_open)
- `recall_source_total{source}` — vector_cache / warm_cache / precomputed / fallback / empty
- `memory_save_total{plan,quota_mode}` — save outcomes by plan tier

### Request timing

`src/observability/request-timing.ts` uses `AsyncLocalStorage` to accumulate sub-operation timings (embed_ms, vector_ms, insert_ms, etc.) across async hops within a single request. The middleware (`transport/http/middleware/request-timing.middleware.ts`) flushes collected fields into the response log line.

## Consequences

- `console.log` in production paths is a lint error — enforced by `no-restricted-syntax` ESLint rule.
- Correlation IDs flow from HTTP middleware → use cases → infrastructure → provider calls via `AsyncLocalStorage`.
- Replacing the metrics sink (e.g. adding Prometheus) requires only a constructor swap in `composition-root.ts`.
- OpenTelemetry collector wiring is out of scope (hooks are exposed, collector is not wired).
