# Contributing to Tallei

## Architecture overview

See [`docs/architecture.md`](docs/architecture.md) for the full layer diagram.
The canonical rule: **data flows inward** — transport → orchestration → providers/infrastructure → domain.
No layer may import from a layer further out than itself.

---

## Dependency rules (enforced by ESLint + dependency-cruiser)

```
domain          →  shared only
shared          →  (nothing)
config          →  shared
resilience      →  shared, observability
observability   →  shared, config
providers/ai    →  resilience, shared, observability, config
infrastructure  →  domain (types only), resilience, shared, observability, config
orchestration   →  domain, providers, infrastructure, resilience, shared, observability, config
transport       →  orchestration, domain, shared, observability, config, resilience
bootstrap       →  EVERYTHING  (sole wiring point)
```

**Hard prohibitions** — enforced in CI:

| From | May NOT import |
|---|---|
| `domain/**` | Anything outside `shared/**` |
| `providers/**` | `orchestration/**`, `transport/**` |
| `infrastructure/**` | `orchestration/**`, `transport/**` |
| `transport/**` | `infrastructure/**` directly (receive via AppServices) |
| Any module | Module-level singletons using `new OpenAI()` etc. outside `providers/ai/` |

Run `npm run deps:check` (madge circular) and `npm run deps:rules` (dependency-cruiser) before pushing.

---

## Adding a new MCP tool

1. Define the tool in `src/transport/mcp/tools/<tool-name>.ts` using the frozen JSON Schema format.
2. Add a matching use case in `src/orchestration/` if logic exceeds trivial.
3. Wire the use case into `src/bootstrap/composition-root.ts`.
4. Run `npm run test:contract` — the golden snapshot must still match (tool names + schemas are frozen).
5. Update `src/transport/mcp/schemas.ts` if you add new argument types.

> **Never rename or remove existing MCP tool names.** External consumers (Claude.ai connector, ChatGPT Actions) depend on the frozen schema.

---

## Adding a new HTTP route

1. Create `src/transport/http/routes/<name>.ts` exporting a Router.
2. Add a matching DTO in `src/transport/http/dto/`.
3. Wire into `src/bootstrap/server.ts` via `app.use(...)`.
4. Run `npm run test:contract` — golden route snapshot must still match.

---

## Provider calls

All LLM and embedding calls go through `src/providers/ai/registry.ts`. **Never** instantiate `OpenAI` directly outside `src/providers/ai/`.

- Chat completions: `registry.chat(req)` — wrapped by `chatPolicy` from `src/resilience/policies.ts`.
- Embeddings: `registry.embed(req)` — wrapped by `embedPolicy`.

Prompt templates live in `src/providers/ai/prompt-templates/`. Keep prompts isolated from business logic.

---

## Resilience policies

Named policies are built once in `src/bootstrap/composition-root.ts` and injected via DI. Never instantiate `CircuitBreaker`, `retry`, or `withTimeout` in business logic.

| Policy name | Capability | Defined in |
|---|---|---|
| `chatPolicy` | chat completions | `resilience/policies.ts` |
| `embedPolicy` | embeddings | `resilience/policies.ts` |
| `rerankPolicy` | reranking | `resilience/policies.ts` |
| `summarizePolicy` | summarization | `resilience/policies.ts` |
| `vectorSearchPolicy` | Qdrant search | `resilience/policies.ts` |
| `vectorUpsertPolicy` | Qdrant upsert | `resilience/policies.ts` |

Circuit breakers are keyed by `(provider, capability)` — e.g. `openai:chat`, `qdrant:search`.

---

## Error taxonomy

All errors extend `AppError` from `src/shared/errors/`. Use the typed subclasses:

| Class | `kind` | `retriable` |
|---|---|---|
| `ProviderTimeout` | `provider_timeout` | true |
| `ProviderRateLimited` | `provider_rate_limited` | true |
| `ProviderTransient` | `provider_transient` | true |
| `ProviderFatal` | `provider_fatal` | false |
| `ProviderAuthError` | `provider_auth` | false |
| `CircuitOpen` | `circuit_open` | false |
| `DomainError` | `domain_*` | false |
| `HttpError` | `http_*` | false |

Providers map SDK errors → these types in `src/providers/ai/errors.ts`.

---

## Observability

- Log with `logger` from `src/observability/logger.ts` (JSON, structured, correlation-id aware).
- Record timing with `requestTiming` from `src/observability/request-timing.ts` (AsyncLocalStorage).
- Increment counters via `metrics` from `src/observability/metrics.ts`.

Never use `console.log` in production paths. `console.warn` in non-production conditional blocks is acceptable for dev debugging.

---

## Config

Config is loaded once at boot in `src/config/load.ts` and fails fast with aggregated validation errors. Access it as `import { config } from "../config.js"`.

- Add new env vars to `src/config/load.ts` **and** `src/config/schema.ts`.
- Group them under the `TALLEI_*` prefix convention (`TALLEI_LLM__*`, `TALLEI_QDRANT__*`, etc.).
- Use `readBooleanEnv`, `readIntEnv`, `readFloatEnv`, `requireEnv`, `readStringEnv` helpers — never `process.env.*` directly.

---

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm run test:unit` | Resilience primitives, use-case logic (pure DI) |
| Integration | `npm run test:integration` | Full stack with in-memory repos (no real DB) |
| Contract | `npm run test:contract` | Golden snapshot of HTTP routes + MCP tool schemas |

Rules:
- Unit tests have no I/O (no real DB, no OpenAI, no Qdrant).
- Integration tests use prototype-patched in-memory repositories.
- Contract tests snapshot `route.path + route.method` and `tool.name + tool.inputSchema`.
- All tests must pass before merging. The one known flaky test (`fast recall returns immediate recent fallback`) is tracked in [issue #TBD] and does not block merge.

---

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat:     new capability
fix:      bug fix
refactor: restructuring without behavior change
perf:     performance improvement
test:     tests only
docs:     documentation only
chore:    build, tooling, deps
```

Large features go on feature branches; merge via PR. Run `npm run build && npm run lint && npm test` before opening a PR.

---

## Quality gates (all run in CI)

```bash
npm run build          # tsc strict, must pass
npm run lint           # eslint + boundaries rule, must pass
npm run deps:check     # madge --circular, must be 0 cycles
npm run deps:rules     # dependency-cruiser, must be 0 violations
npm run test:contract  # golden snapshots, must match exactly
npm test               # all suites, must pass
```
