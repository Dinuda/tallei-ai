# ADR-002 — Single-provider resilience, no cross-provider failover

**Status**: Accepted  
**Date**: 2026-04-18

## Context

The codebase had 8 provider SDKs installed. One plausible evolutionary path was to fail over from OpenAI to Anthropic or Mistral on rate-limit or outage. Cross-provider failover sounds resilient but introduces hidden costs:

1. **Prompt drift.** System prompts, temperature behaviour, JSON-mode support, and context window sizes differ per provider. A summary written for GPT-4o-mini may be structured differently from one from Claude 3 Haiku, causing downstream logic (fact extraction, graph building) to receive inconsistent shapes.
2. **Billing complexity.** Two active provider accounts means two billing anomaly surfaces, two sets of rate limits, and two key rotation schedules.
3. **Testing surface explosion.** Every LLM-backed use case must be validated against every provider in the failover chain.
4. **Observability difficulty.** Correlating a specific output back to a specific model version is harder when the model can change mid-flight.

## Decision

Tallei supports **one active provider at a time** (`config.llmProvider`). The resilience layer (retry + timeout + circuit breaker) handles transient failures within that provider. If the circuit opens, operations degrade gracefully (return cached results, fall to lexical recall, skip fact extraction) rather than switching providers.

Adapters for additional providers (`OllamaProvider`, and stubs for others) may be implemented as `AiProvider` implementations, but runtime failover between them is explicitly out of scope.

## Consequences

- Resilience policy table is flat: one set of circuits per `(provider, capability)` pair.
- Provider swap is a config change + redeploy, not a runtime toggle.
- Outage during circuit-open degrades gracefully per capability (see `docs/architecture.md` resilience matrix).
- Adding cross-provider failover in the future requires prompt equivalence testing — that gate is acknowledged and documented.
