# ADR-001 — Provider adapter interface shape

**Status**: Accepted  
**Date**: 2026-04-18

## Context

Tallei previously called the OpenAI SDK directly at the call site in every service file (`summarizer.ts`, `reranker.ts`, `factExtractor.ts`, `memoryGraphExtractor.ts`, etc.). Each file created its own module-level `new OpenAI()` singleton, hand-rolled its own retry/timeout, and mapped SDK errors ad hoc. Eight additional provider SDKs (`@anthropic-ai/sdk`, `@google/genai`, `@mistralai/mistralai`, `groq-sdk`, `@azure/*`, `@langchain/core`, `ollama`, `mem0ai`) were installed but unused, indicating drift toward multi-provider ambitions without a seam to support them.

## Decision

All LLM and embedding I/O is routed through a single `AiProvider` interface defined in `src/providers/ai/ai-provider.ts`:

```typescript
interface AiProvider {
  readonly name: "openai" | "ollama";
  capabilities(): ProviderCapabilities;
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}
```

Two concrete adapters exist:
- `OpenAiProvider` — wraps the `openai` npm SDK against OpenAI's endpoint.
- `OllamaProvider` — wraps the same `openai` npm SDK pointed at Ollama's `/v1` base URL (OpenAI-compatible).

`ProviderRegistry` (built once in `composition-root.ts`) selects the active adapter from `config.llmProvider`. All call sites import only `registry.chat(req)` / `registry.embed(req)`.

All requests include `AbortSignal` so timeouts actually cancel in-flight I/O rather than merely timing out the JS side.

## Consequences

- Adding a third provider requires only a new `AiProvider` implementation and one config line — no call site changes.
- Resilience policies, observability, and prompt templates are decoupled from SDK details.
- Unit tests can inject a stub `AiProvider` without needing to mock the OpenAI SDK.
- All 8 unused provider SDKs are safely removed (ADR-002 governs the single-provider constraint).
