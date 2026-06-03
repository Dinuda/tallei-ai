# Loops, Agents, Runs, Approvals, and Connectors

This document describes the current loop workflow runtime after removing the legacy workflow automation service and builder flow.

The active backend is loop executor v2:

- `src/services/loop-executor/*`: loop creation, scheduling, strategy, agent tasks, gates, approvals, distribution, and run recovery.
- `src/services/approval-tokens.ts`: approval token creation, resolution, and consumption.
- `src/services/channels.ts`: email, Gmail, Telegram, and inbound approval/input handling.
- `src/services/connectors/composio.ts`: Composio auth, connector account listing, webhook handling, tool execution plumbing, and Resend connector setup.
- `src/transport/http/routes/workflows.ts`: loop and run HTTP API.
- `src/transport/http/routes/connectors.ts`: connector HTTP API.
- `src/transport/http/routes/channels.ts`: notification channel HTTP API and webhooks.

Removed legacy pieces:

- `src/services/workflow-automation.ts`
- `src/services/workflow-automation/workflow-builder.service.ts`
- `src/services/workflow-automation/daily-intelligence/*`
- `src/services/workflow-sdk-runtime.ts`
- `src/orchestration/workflows/definitions.ts`
- Dashboard `/dashboard/workflows/*` builder pages

## Whole System Flow

```mermaid
flowchart TD
  A["Admin creates loop"] --> B["workflows row stores loopDefinition"]
  B --> C{"Run source"}
  C -->|"Manual route"| D["executeLoopWorkflow"]
  C -->|"Scheduler wake"| D
  D --> E["CEO strategy heartbeat"]
  E --> F["Run waits for strategy approval"]
  F --> G["Operator approves or edits roster"]
  G --> H["Tasks are materialized"]
  H --> I["Heartbeat jobs run agents"]
  I --> J{"Gate or approval needed?"}
  J -->|"Gate"| K["Wait for token/UI/channel input"]
  K --> I
  J -->|"Final draft approval"| L["Wait for run approval"]
  L --> M["Approve via UI/token/channel"]
  J -->|"No approval"| N["CEO finalizes"]
  M --> O{"Distribution needed?"}
  O -->|"Yes"| P["Upload contacts / distribution heartbeat"]
  P --> Q["Resend broadcast"]
  O -->|"No"| N
  Q --> R["Run completed or blocked"]
  N --> R
```

## Data Model

Core tables:

- `workflows`: saved loop definition, with `definition_version = "loop_executor_v2"`.
- `workflow_runs`: one run instance and run-level loop metadata.
- `loop_run_tasks`: materialized agent or external-action work.
- `loop_run_comments`: shared thread between CEO, agents, and operator.
- `loop_run_events`: audit/observability events.
- `loop_heartbeat_jobs`: durable queue for agents, finalization, and distribution.
- `loop_run_artifacts`: dynamic plan outputs.
- `loop_run_gates`: dynamic approval or input pauses.
- `loop_workspaces`: grouping for internal loops.
- `workflow_approval_tokens`: token-backed approvals for runs and gates.
- `connector_accounts`, `connector_auth_sessions`, `connector_action_events`: Composio/connector state and audit.

The canonical loop definition is stored at:

- `workflows.metadata_json.loopDefinition`

Run-local executor state is stored at:

- `workflow_runs.metadata_json.loop_executor`

Important run metadata keys:

- `proposedRoster`
- `approvedRoster`
- `strategyReadyAt`
- `rosterApprovedAt`
- `approvalRequest`
- `approvalDecision`
- `pendingInput`
- `artifactBody`
- `newsletterBody`
- `publicistApproval`
- `contactList`
- `distribution`
- `deliveryAction`
- `activeGateId`
- `activeGateStageId`

## Loop Creation

Loop creation is handled by `createLoopWorkflow()` in `src/services/loop-executor/creator.ts`.

HTTP route:

- `POST /api/workflows/internal/loops`

Simple flow:

```mermaid
flowchart TD
  A["POST /api/workflows/internal/loops"] --> B["requireLoopAdmin"]
  B --> C["normalize task, cron, timezone"]
  C --> D["store parent agent shell"]
  D --> E{"Explicit graph or plan supplied?"}
  E -->|"Yes"| F["parse supplied child agents/tools/gates"]
  E -->|"No"| G["leave children/tools/gates undefined"]
  F --> H["derive/keep executor plan"]
  G --> I["runtime CEO decides roster later"]
  H --> J["compute fingerprint and first next_run_at"]
  I --> J
  J --> K["insert workflows row"]
  K --> L["return loop view"]
```

What gets created:

- A `workflows` row.
- `metadata_json.loopDefinition`.
- `loopDefinition.agentGraph.parent`.
- `loopDefinition.agentGraph.children` only when supplied by a planner/API caller.
- `loopDefinition.plan` only when supplied directly or derivable from supplied child agents.
- `next_run_at` for scheduling.
- Optional workspace assignment.

Intent detection is deliberately not part of creation right now. `parseLoopIntent()` still exists as a future hook, but `createLoopWorkflow()` no longer calls it.

## Scheduling

Scheduling lives in `src/services/loop-executor/scheduler.ts`.

Wake routes:

- `POST /api/workflows/internal/loops/scheduler/wake`
- `POST /api/workflows/internal/loops/heartbeat/dispatch`

Simple flow:

```mermaid
flowchart TD
  A{"Scheduler source"} -->|"Internal interval"| B["dispatchDueLoopWorkflows"]
  A -->|"Cloudflare wake"| B
  B --> C["claim due workflows with SKIP LOCKED"]
  C --> D["advance next_run_at"]
  D --> E["executeLoopWorkflow"]
  E --> F["run starts"]
```

## Run Handling

Runs are created by `executeLoopWorkflow()` in `src/services/loop-executor/executor.ts`.

Manual run route:

- `POST /api/workflows/internal/loops/:workflowId/run`

Simple flow:

```mermaid
flowchart TD
  A["executeLoopWorkflow"] --> B["load active loop workflow"]
  B --> C["insert workflow_runs row"]
  C --> D["insert workflow.started event"]
  D --> E["runCeoStrategyHeartbeat"]
  E --> F["strategy + proposed roster"]
  F --> G["status = waiting_for_strategy_approval"]
```

Status starts as `running`, then usually moves quickly to `waiting_for_strategy_approval`.

## Agent Creation and Spawning

Agents are not long-lived processes. Creator stores the parent-agent shell. Child agents, tools, approval gates, and done conditions must come from a later planner/API input or from runtime CEO roster generation.

Agent spec shape comes from `loopRunAgentSchema` in `src/services/loop-executor/types.ts`:

- `id`
- `name`
- `task`
- `tools`

Simple flow:

```mermaid
flowchart TD
  A["creator.ts"] --> B["Parent Agent"]
  B --> C{"Child graph supplied?"}
  C -->|"Yes"| D["Use supplied children/tools"]
  C -->|"No"| E["No child agents at create time"]
  D --> F{"Plan supplied or derivable?"}
  F -->|"Yes"| G["CEO converts plan stages to roster"]
  F -->|"No"| H["CEO generates roster at runtime"]
  E --> H
  G --> I["Operator reviews roster"]
  H --> I
  I --> J["approveLoopStrategy"]
  J --> K["materialize loop_run_tasks"]
```

How agents are spawned:

1. Creator stores `agentGraph.parent`.
2. Creator stores `agentGraph.children` only if supplied.
3. Creator stores `plan.stages` only if supplied or derivable from supplied children.
4. If no plan exists, CEO strategy heartbeat dynamically generates `proposedRoster` from the goal and tool catalog.
5. Operator can edit the roster through:
   - `GET /api/workflows/runs/:runId/roster`
   - `PUT /api/workflows/runs/:runId/roster`
6. Operator approves strategy through:
   - `POST /api/workflows/runs/:runId/approve-strategy`
7. `approveLoopStrategy()` writes `approvedRoster`.
8. Tasks are inserted into `loop_run_tasks`.
9. Heartbeat jobs execute tasks one at a time.

## Agent Execution

Agent execution is handled by `runAgentHeartbeat(runId, taskId)`.

Simple flow:

```mermaid
flowchart TD
  A["heartbeat job: agent"] --> B["checkout task with SKIP LOCKED"]
  B --> C["mark task in_progress"]
  C --> D["load comments and agent spec"]
  D --> E["validate tools and connectors"]
  E --> F["runLoopAgent or dynamic action branch"]
  F --> G["write agent comment"]
  G --> H["mark task done"]
  H --> I{"More work?"}
  I -->|"Next task"| J["enqueue next agent heartbeat"]
  I -->|"Gate"| K["pauseForDynamicGate"]
  I -->|"Done"| L["enqueue CEO finalizer"]
```

Failure behavior:

- Retryable errors reset the task to `todo` and let the heartbeat retry.
- Non-retryable errors mark the task `blocked`.
- Blocked runs get a CEO comment, `run_blocked` event, and status notification.

## Heartbeat Queue

Heartbeat jobs live in `loop_heartbeat_jobs`.

Job types:

- `agent`
- `ceo_finalize`
- `distribution`

Simple flow:

```mermaid
flowchart TD
  A["enqueueLoopHeartbeatJob"] --> B["loop_heartbeat_jobs row"]
  B --> C{"Dispatch mode"}
  C -->|"Immediate"| D["scheduleDelayedHeartbeatDispatch"]
  C -->|"Worker / Cloudflare"| E["dispatchLoopHeartbeatJobs"]
  D --> F["find + lock pending job"]
  E --> F
  F --> G{"job_type"}
  G -->|"agent"| H["runAgentHeartbeat"]
  G -->|"ceo_finalize"| I["runCeoFinalizeHeartbeat"]
  G -->|"distribution"| J["runDistributionHeartbeat"]
  H --> K["complete or fail job"]
  I --> K
  J --> K
```

## Gates

Dynamic plans can pause at human gates.

Gate types:

- `approval_gate`
- `input_gate`

Simple flow:

```mermaid
flowchart TD
  A["Agent/task reaches gate stage"] --> B["pauseForDynamicGate"]
  B --> C["upsert loop_run_gates row"]
  C --> D["status = waiting_for_gate"]
  D --> E{"Gate type"}
  E -->|"approval_gate"| F["send approval token"]
  E -->|"input_gate"| G["send input-needed notification"]
  F --> H["approve token or UI"]
  G --> I["submit input"]
  H --> J["gate_completed"]
  I --> J
  J --> K["clear active gate metadata"]
  K --> L["schedule next task or finalizer"]
```

Gate routes currently exposed by backend are token-centric through workflow approval URLs. Gate service functions are exported, but explicit authenticated gate list/approve/reject/input routes are still a gap.

## Approval Tokens

Approval tokens now live in `src/services/approval-tokens.ts`.

Functions:

- `createWorkflowApprovalRequest()`
- `resolveWorkflowApprovalToken()`
- `consumeWorkflowApprovalToken()`

Supported loop targets:

- `workflow_run`
- `workflow_gate`

Simple flow:

```mermaid
flowchart TD
  A["Need human decision"] --> B["createWorkflowApprovalRequest"]
  B --> C["workflow_approval_tokens row"]
  C --> D["approval URL"]
  D --> E{"Delivery"}
  E -->|"Email/Gmail"| F["channel prompt"]
  E -->|"Telegram"| G["channel prompt"]
  E -->|"UI"| H["direct action"]
  F --> I["approve/skip route"]
  G --> I
  H --> I
  I --> J["resolve token"]
  J --> K["run or gate approval handler"]
  K --> L["consume token"]
```

Approval routes:

- `GET /api/workflows/approvals/:token`
- `GET /api/workflows/approvals/:token/approve`
- `POST /api/workflows/approvals/:token/approve`
- `POST /api/workflows/approvals/:token/skip`
- `GET /api/workflows/loops/approvals/:token`
- `GET /api/workflows/loops/approvals/:token/approve`
- `POST /api/workflows/loops/approvals/:token/approve`

The generic approval route no longer falls back to legacy workflow suggestions or legacy workflow runs.

## Publicist / Newsletter Approval

The newsletter path uses `internal.email_approval_request`.

Simple flow:

```mermaid
flowchart TD
  A["Publicist agent"] --> B["internal.email_approval_request"]
  B --> C["extract newsletter body"]
  C --> D["create workflow_run approval token"]
  D --> E["sendWorkflowRunApprovalPrompt"]
  E --> F["status = waiting_for_email_approval"]
  F --> G{"Approval source"}
  G -->|"Token"| H["approveLoopRunApprovalToken"]
  G -->|"UI"| I["approveLoopRunFromUi"]
  H --> J["store approval metadata"]
  I --> J
  J --> K{"Need contacts?"}
  K -->|"Yes"| L["status = waiting_for_contact_list"]
  K -->|"No"| M["continue/finalize"]
```

Contact upload:

- `POST /api/workflows/runs/:runId/contacts`

Draft approval is required before contact upload.

## Distribution

Distribution is handled by `runDistributionHeartbeat()`.

Simple flow:

```mermaid
flowchart TD
  A["Approved draft + contacts"] --> B["uploadLoopRunContacts"]
  B --> C["status = executing_action"]
  C --> D["enqueue distribution heartbeat"]
  D --> E["resolve content"]
  E --> F["create/reuse Resend segment"]
  F --> G["sync contacts in batches"]
  G --> H{"Contacts remaining?"}
  H -->|"Yes"| D
  H -->|"No"| I["create and send broadcast"]
  I --> J["write distribution metadata"]
  J --> K["completed or blocked"]
```

## Finalization

CEO finalization is handled by `runCeoFinalizeHeartbeat()`.

Simple flow:

```mermaid
flowchart TD
  A["No more tasks"] --> B["runCeoFinalizeHeartbeat"]
  B --> C["load tasks and comments"]
  C --> D{"Any task blocked?"}
  D -->|"Yes"| E["mark run blocked"]
  D -->|"No"| F["CEO finalizer model"]
  F --> G["detect draft payloads"]
  G --> H{"Draft approval required?"}
  H -->|"Yes"| I["status = waiting_for_approval"]
  H -->|"No"| J["status = completed"]
  I --> K["send status/approval notification"]
  J --> K
```

## Connectors and Composio

Composio integration now lives in `src/services/connectors/composio.ts`.

Connector routes:

- `GET /api/connectors`
- `DELETE /api/connectors/:id`
- `POST /api/connectors/:provider/auth-sessions`
- `GET /api/connectors/auth-sessions/:id`
- `POST /api/connectors/auth-sessions/:id/continue`
- `GET /api/connectors/composio/toolkits`
- `POST /api/connectors/composio/webhook`
- `GET /api/connectors/resend`
- `POST /api/connectors/resend`
- `DELETE /api/connectors/resend`
- `DELETE /api/connectors/resend/:id`

Simple Composio auth flow:

```mermaid
flowchart TD
  A["POST connector auth session"] --> B["startConnectorAuth"]
  B --> C["infer Composio app/toolkit"]
  C --> D["create Composio connect link"]
  D --> E["insert connector_auth_sessions"]
  E --> F["user completes Composio auth"]
  F --> G{"Completion source"}
  G -->|"Webhook"| H["handleComposioWebhook"]
  G -->|"Manual continue"| I["continueConnectorAuth"]
  H --> J["upsert connector_accounts"]
  I --> J
```

Composio tool execution is still available through the connector adapter, but loop agent execution treats Composio Gmail tools as approval-gated draft/action payloads rather than blind sends.

## Notification Channels

Channel code lives in `src/services/channels.ts`.

Supported kinds:

- `email`
- `gmail`
- `telegram`
- `whatsapp`

Simple flow:

```mermaid
flowchart TD
  A["Loop needs notification"] --> B["getPrimaryNotificationChannel"]
  B --> C{"Message type"}
  C -->|"Status"| D["deliverStatusNotification"]
  C -->|"Approval"| E["deliverApprovalPrompt"]
  D --> F["email/gmail/telegram delivery"]
  E --> F
  F --> G["Inbound webhook or clicked link"]
  G --> H["process inbound action"]
  H --> I["approve run, approve gate, reject gate, or submit input"]
```

## HTTP Route Map

Loop lifecycle:

- `GET /api/workflows`
- `GET /api/workflows/internal/loops`
- `POST /api/workflows/internal/loops`
- `GET /api/workflows/internal/loops/:workflowId`
- `GET /api/workflows/internal/loops/:workflowId/runs`
- `POST /api/workflows/internal/loops/:workflowId/run`

Scheduler:

- `POST /api/workflows/internal/loops/scheduler/wake`
- `POST /api/workflows/internal/loops/heartbeat/dispatch`

Workspaces:

- `GET /api/workflows/workspaces`
- `POST /api/workflows/workspaces`
- `POST /api/workflows/workspaces/assign-loop`

Runs:

- `GET /api/workflows/runs/:runId`
- `GET /api/workflows/runs/:runId/tasks`
- `GET /api/workflows/runs/:runId/comments`
- `POST /api/workflows/runs/:runId/comments`
- `GET /api/workflows/runs/:runId/roster`
- `PUT /api/workflows/runs/:runId/roster`
- `POST /api/workflows/runs/:runId/approve`
- `POST /api/workflows/runs/:runId/approve-strategy`
- `POST /api/workflows/runs/:runId/resume`
- `POST /api/workflows/runs/:runId/tasks/:taskId/rerun`
- `POST /api/workflows/runs/:runId/contacts`

Approval links:

- `GET /api/workflows/approvals/:token`
- `GET /api/workflows/approvals/:token/approve`
- `POST /api/workflows/approvals/:token/approve`
- `POST /api/workflows/approvals/:token/skip`
- `GET /api/workflows/loops/approvals/:token`
- `GET /api/workflows/loops/approvals/:token/approve`
- `POST /api/workflows/loops/approvals/:token/approve`

## Status Lifecycle

Common run statuses:

- `running`
- `waiting_for_strategy_approval`
- `strategy_approved`
- `waiting_for_gate`
- `waiting_for_email_approval`
- `waiting_for_approval`
- `waiting_for_contact_list`
- `waiting_for_input`
- `executing_action`
- `distributing`
- `completed`
- `blocked`

Task statuses:

- `todo`
- `in_progress`
- `done`
- `blocked`

Gate statuses:

- `pending`
- `approved`
- `submitted`
- `rejected`

Heartbeat job statuses:

- `pending`
- `processing`
- `done`
- `failed`

## Dashboard Surfaces

Relevant dashboard paths:

- `dashboard/app/dashboard/loops/page.tsx`: loop list.
- `dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx`: run detail.
- `dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/*`: agent rows, chat drawer, strategy roster editor.
- `dashboard/app/dashboard/channels/page.tsx`: notification channels.

The removed workflow builder pages under `dashboard/app/dashboard/workflows/*` are no longer part of the product surface.

## Current Gaps

- Explicit authenticated gate list/approve/reject/input routes are not exposed yet, even though service functions exist.
- Composio Gmail catalog tools are approval-gated and primarily prepare draft/action payloads from agent execution.
- `internal.resend_broadcast` is a dynamic external-action path, not a normal `runLoopAgent()` tool path.
- Contact upload requires prior draft approval.
- Heartbeat scheduling uses both immediate dispatch and durable queue rows; the queue remains the idempotency/audit mechanism.
- `schedulerTarget` is stored on loop definitions, but actual scheduling is controlled by config plus internal or Cloudflare wake routes.
