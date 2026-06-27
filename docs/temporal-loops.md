# Temporal loop engine (local dev)

See **[Conductor](./conductor.md)** for the full loop authoring flow (chat → compile → activate → run).

Tallei runs workspace-scoped loops through a generic `loopRunWorkflow` when `TALLEI_TEMPORAL__ENABLED=true`.

## Prerequisites

- PostgreSQL with loop engine tables (`TALLEI_DB__AUTO_MIGRATE_ON_BOOT=true` applies `loop-engine-schema`)
- Composio configured for workspace-scoped connectors
- LLM provider (e.g. OpenCode):

```env
TALLEI_LLM__LOCAL_MODEL_MODE=false
TALLEI_LLM__PROVIDER=opencode
TALLEI_LLM__OPENCODE_BASE_URL=https://opencode.ai/zen/v1
TALLEI_LLM__OPENCODE_MODEL=big-pickle
TALLEI_CONDUCTOR__MODEL=big-pickle
# legacy alias: TALLEI_LOOP_BUILDER__OPENAI_MODEL
TALLEI_TEMPORAL__ENABLED=true
TALLEI_TEMPORAL__ADDRESS=127.0.0.1:7233
TALLEI_TEMPORAL__NAMESPACE=default
TALLEI_TEMPORAL__TASK_QUEUE=loop-runs
```

## Start stack

```bash
# Temporal server (docker compose profile)
docker compose --profile temporal up -d

# API
npm run dev

# Temporal worker (separate terminal)
npm run temporal:worker

# Dashboard
cd dashboard && npm run dev
```

## Verify

1. Open `/dashboard/loops`, pick a starter card
2. Conductor chat streams via `POST /api/loops/:id/chat` (proxied through Next.js with session auth)
3. Compile → Activate (registers Temporal Schedule when trigger is `schedule`)
4. Run now → check `loop_runs` in Postgres or Temporal UI at http://localhost:8233
5. Sensitive tool steps create `approval_requests`; decide at `/dashboard/approvals` (signals workflow)

## Architecture notes

- **Workflow** (`src/temporal/workflows/loop-run.workflow.ts`): deterministic orchestration only
- **Activities**: planner (`generateObject`), Composio tool execute, approval create, deliver output
- **Profiles**: `agentic` (default), `monitor` (rule evaluation), `sync` (preview; full bidirectional sync is v2)
- **Worker** runs as its own process — not embedded in the Express `startWorkers()` bootstrap

## Webhooks

Composio webhooks hit either endpoint (same handler):

- `POST /api/webhooks/composio`
- `POST /api/connectors/composio/webhook` (dashboard proxy alias)

Configure `TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET` and register the URL in Composio.

Signature headers supported:

- `webhook-id`, `webhook-timestamp`, `webhook-signature` (HMAC)
- legacy `x-composio-signature`

Trigger payloads must include a workspace-scoped Composio entity id:

```
tallei:{tenantId}:{userId}:{workspaceId}
```

The handler maps Composio `trigger_slug` values (e.g. `GMAIL_NEW_GMAIL_MESSAGE`) to loop spec event triggers (`source` + `eventType`) and starts matching active loops.

Auth lifecycle webhooks (`connected_account.*`) invalidate the in-memory Composio session cache so connector status refreshes after OAuth.

## Connectors API

Workspace-scoped connector status and OAuth (Composio session as source of truth):

| Endpoint | Purpose |
|----------|---------|
| `GET /api/connectors` | List toolkits + live `connected` status |
| `GET /api/connectors/status/:toolkit` | Single toolkit status |
| `POST /api/connectors/:toolkit/authorize` | Start OAuth (`redirectUrl`, `connectionRequestId`) |
| `POST /api/connectors/authorize/:id/verify` | Poll until connected |
| `DELETE /api/connectors/:toolkit` | Disconnect |

Required env:

```env
TALLEI_CONNECTORS__COMPOSIO_API_KEY=...
TALLEI_CONNECTORS__COMPOSIO_WEBHOOK_SECRET=...
TALLEI_CONNECTORS__COMPOSIO_ENTITY_PREFIX=tallei
```

Event-triggered loops register a Composio trigger instance on **Activate** (`loop_trigger_registrations` table).
