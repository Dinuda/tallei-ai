# Loop Builder Refactor Plan

## Goal
Shift from newsletter-only to a generic loop builder system that uses the full Tallei ecosystem (memory, channels, connectors, Composio). Newsletter becomes one benchmark preset, not the execution path.

## Current State Summary

**Already generic (can reuse as-is):**
- Type system (`types.ts`) — Zod schemas support arbitrary stages, artifacts, tools, plans
- Tool catalog structure — ref, schemas, risk levels, artifact kinds are domain-agnostic
- Plan system — 4 stage kinds (`agent`, `approval_gate`, `input_gate`, `external_action`)
- Gate system — `completeDynamicGate()` and token-based approval are generic
- `DeliveryContentFormatter` interface — fully pluggable contract
- Workflow persistence — `workflows` table stores definitions as JSON
- Backend CRUD API endpoints — create/read/list/run/manage are generic
- Heartbeat execution model — scheduler + worker pattern is domain-agnostic
- Strategy roster editor — works for any loop type
- Channel system — email, gmail, telegram, whatsapp delivery paths
- Composio connector system — extensible toolkit actions

**Blocked by newsletter coupling:**
- `agent-runner.ts` — hardcoded `if/else` tool dispatch, newsletter system prompts
- `delivery-format.ts` — binary newsletter-vs-plain decision
- `creator.ts` — auto-detects newsletter preset from goal text, admin-only gate
- `gates.ts` — imports `parseContactListCsv` from newsletter preset
- `executor.ts` — `external_action` only allows `internal.resend_broadcast`
- `approval.ts` — hardcoded newsletter approval → CSV → broadcast flow
- `presets/registry.ts` — eager newsletter heuristics
- Dashboard UI — hardcoded newsletter card, newsletter-specific titles/breadcrumbs, newsletter-only run detail

---

## Phase 1: Unblock the Engine (Backend Decoupling)

**Goal:** Any loop definition that isn't a newsletter can execute end-to-end without hitting newsletter-specific code paths.

### 1.1 Remove the admin gate
- **File:** `src/services/loop-executor/creator.ts`
- **Change:** Remove `requireLoopAdmin()` call from `createLoopWorkflow()` and `getLoopWorkflow()`. All authenticated users with `memory:write` scope can create loops.
- **Risk:** Low. The OAuth + scope middleware on the route already gates access.

### 1.2 Stop auto-detecting newsletter preset
- **File:** `src/services/loop-executor/creator.ts` (`buildLoopDefinition`, ~line 117)
- **Change:** Remove the auto-preset heuristic that sets `presetId: "newsletter"` when the goal contains "newsletter" or matches `isLennyNewsletterGoal()`. The user must explicitly set `presetId` in the creation request, or the system should only use it when the request includes newsletter-specific tool refs.
- **File:** `src/services/loop-executor/presets/registry.ts` (`resolveLoopPreset`, ~line 19)
- **Change:** Remove the fallback heuristics (`/\bnewsletter\b/i` on goal, `resend_broadcast` in tools). Only match on explicit `presetId`.
- **Why:** Prevents custom loops from being hijacked into the newsletter path.

### 1.3 Extract tool dispatch registry
- **File:** `src/services/loop-executor/agent-runner.ts`
- **Change:** Replace the `if/else` chain in `runAssignedTools()` with a `Map<string, ToolHandler>` registry. Each handler is a function: `(ctx, tool, config) => Promise<ToolResult>`.
- **New file:** `src/services/loop-executor/tool-handlers.ts`
  - Register existing handlers: `memory_search`, `web_search`, `email_approval_request`, `email_builder_render`, `email_builder_compose`, `resend_broadcast`, `composio.*`
  - Each handler is extracted from the current inline code
- **Why:** New tools can register handlers without modifying `agent-runner.ts`.

### 1.4 Extract delivery formatter registry
- **File:** `src/services/loop-executor/delivery-format.ts`
- **Change:** Replace the binary `isNewsletterLoopDefinition` check with a `Map<string, DeliveryContentFormatter>` registry. Key by `presetId` or `deliveryType` field on the definition.
- **Fallback:** `plainDeliveryFormatter` remains the default for unregistered types.
- **Remove:** The `looksLikeNewsletterContent()` heuristic fallback — it's fragile and newsletter-specific.

### 1.5 Decouple gates from newsletter preset
- **File:** `src/services/loop-executor/gates.ts`
- **Change:** Remove the `parseContactListCsv` import from `presets/newsletter.js`. Move `parseContactListCsv` to a shared utility (`src/services/loop-executor/csv-parser.ts`) since it's a generic CSV parser.
- **Why:** The gates module should not import from presets.

### 1.6 Generalize external_action execution
- **File:** `src/services/loop-executor/executor.ts` (~line 256)
- **Change:** Remove the hardcoded check `stage.toolRef !== "internal.resend_broadcast"`. Instead, dispatch `external_action` stages through the tool handler registry (from 1.3). Any tool with `isActionable: true` and `riskLevel: "external_action"` can be an external action.
- **Add:** A generic `executeExternalAction()` function that:
  1. Resolves the tool handler from the registry
  2. Gathers input artifacts
  3. Executes the tool
  4. Saves output artifacts
  5. Advances the run

### 1.7 Generalize the approval/delivery flow
- **File:** `src/services/loop-executor/approval.ts`
- **Change:** `transitionRunToDelivery()` should not assume the next step is "waiting for CSV contact list". Instead:
  - If the plan has an `input_gate` after the approval gate → transition to `waiting_for_gate`
  - If the plan has an `external_action` after the approval gate → transition to `executing_action`
  - If the plan has no further stages → transition to `completed`
- **File:** `src/services/loop-executor/approval.ts` (`uploadDeliveryRecipients`)
- **Change:** Make CSV upload a generic `submitLoopRunGateInput` path. The `input_gate` handler (from 1.5) already supports this.
- **Why:** Not all loops need recipient lists. A blog post loop might go: write → approve → publish. No CSV needed.

### 1.8 Remove newsletter conditionals from agent-runner
- **File:** `src/services/loop-executor/agent-runner.ts`
- **Changes:**
  - Remove `isNewsletterWriter` check and the newsletter-specific system prompt injection
  - Move newsletter writer instructions into the newsletter preset's agent `task` text
  - Remove `shouldRenderNewsletterEmail()` and `looksLikeNewsletterApproval()` — resolve the formatter from the registry (1.4) instead
  - Remove hardcoded `import("./presets/newsletter.js")` — use the formatter registry

---

## Phase 2: Open Loop Creation (API Changes)

### 2.1 Public create endpoint
- **File:** `src/transport/http/routes/workflows.ts`
- **Change:** Add a new `POST /api/workflows/loops` endpoint (without `/internal/` prefix) that any authenticated user can access. The existing `/internal/loops` endpoints remain for backward compatibility.
- **Schema update:** `createLoopSchema` should accept:
  - `goal` (required)
  - `cron` (required)
  - `timezone` (optional, default `UTC`)
  - `preset_id` (optional) — explicit preset selection
  - `delivery_type` (optional) — `"email_broadcast"`, `"email_transactional"`, `"channel_notification"`, `"connector_action"`, `"none"`
  - `agents` (optional) — user-defined agent roster
  - `stages` (optional) — user-defined plan stages including gates
  - `approval_policy` (optional) — per-stage approval config
  - `allowed_tool_refs` (optional)
  - `allowed_integrations` (optional)

### 2.2 Per-stage approval policy
- **File:** `src/services/loop-executor/types.ts`
- **Change:** Extend `loopDefinitionSchema` with an optional `approvalPolicy` field:
  ```typescript
  approvalPolicy: z.object({
    stages: z.array(z.object({
      stageId: z.string(),
      kind: z.enum(["auto", "ui_approval", "email_approval", "skip"]),
      channel: z.string().optional(), // which channel to notify
    })).optional(),
    defaultKind: z.enum(["auto", "ui_approval", "email_approval", "skip"]).default("ui_approval"),
  }).optional()
  ```
- **File:** `src/services/loop-executor/creator.ts` (`buildLoopDefinition`)
- **Change:** Accept `approvalPolicy` from the creation request and pass it through to the definition.
- **File:** `src/services/loop-executor/executor.ts` (`runCeoFinalizeHeartbeat`)
- **Change:** Consult `approvalPolicy` instead of the hardcoded `draftPolicy.requireDraftBeforeExternalAction`.

### 2.3 Channel-aware delivery
- **File:** `src/services/loop-executor/distribution.ts`
- **Change:** `runDistributionHeartbeat()` should check the loop's `delivery_type`:
  - `"email_broadcast"` → current Resend broadcast path (newsletter-style)
  - `"email_transactional"` → use `deliverStatusNotification()` from `channels.ts` (single email to the user)
  - `"channel_notification"` → use `deliverStatusNotification()` which routes through the user's primary channel (email, telegram, whatsapp)
  - `"connector_action"` → dispatch through the tool handler registry (e.g., Composio Gmail draft, Notion page, etc.)
  - `"none"` → skip delivery entirely, just mark completed
- **Why:** Blog posts, reports, and social content don't all need a Resend broadcast.

---

## Phase 3: AI-Assisted Builder Wizard (New Feature)

### 3.1 Intent detection via memory
- **New file:** `src/services/loop-executor/intent-resolver.ts`
- **Purpose:** When a user says "I want to create a newsletter/blog/report", this module:
  1. Calls `recallMemories()` with queries about the user's content preferences, past work, writing style, audience
  2. Calls `listPreferences()` for pinned preferences
  3. Returns a `LoopIntent` object: `{ kind, suggestedGoal, suggestedAgents, suggestedTools, suggestedSchedule, memoryContext }`
- **Integration:** Called by the builder wizard API before proposing a loop definition.

### 3.2 Builder wizard API
- **New file:** `src/transport/http/routes/loop-builder.ts` (mounted at `/api/loop-builder`)
- **Endpoints:**
  - `POST /api/loop-builder/propose` — Takes `{ goal, context? }`, returns a proposed `LoopDefinition` draft
    1. Calls intent resolver (3.1)
    2. Uses OpenAI to generate a proposed plan with stages, agents, tools, and approval gates
    3. Returns the proposal as a JSON `LoopDefinition` (not yet persisted)
  - `POST /api/loop-builder/refine` — Takes `{ proposal, feedback }`, returns a refined proposal
  - `POST /api/loop-builder/save` — Takes a finalized `LoopDefinition`, persists it via `createLoopWorkflow()`
- **Auth:** OAuth + `memory:read` for propose/refine, `memory:write` for save.

### 3.3 Preset templates (non-newsletter)
- **New file:** `src/services/loop-executor/presets/blog-post.ts`
  - Agents: Memory Searcher → Web Researcher → Writer → Approval Handoff
  - Tools: `memory_search`, `web_search`, `llm_only`, `email_approval_request`
  - Delivery: `email_transactional` or `connector_action` (Notion/Ghost)
- **New file:** `src/services/loop-executor/presets/weekly-report.ts`
  - Agents: Memory Searcher → Synthesizer → Approval Handoff
  - Tools: `memory_search`, `llm_only`, `email_approval_request`
  - Delivery: `channel_notification` or `email_transactional`
- **New file:** `src/services/loop-executor/presets/social-content.ts`
  - Agents: Memory Searcher → Content Writer → Approval Handoff
  - Tools: `memory_search`, `llm_only`, `email_approval_request`
  - Delivery: `connector_action` (via Composio)
- **Register** all in `presets/registry.ts`.

---

## Phase 4: Builder UI

### 4.1 Loop creation wizard page
- **New file:** `dashboard/app/dashboard/loops/new/page.tsx`
- **Flow:**
  1. User enters a goal in natural language ("I want to write a weekly blog post about AI")
  2. Wizard calls `POST /api/loop-builder/propose`
  3. Shows proposed plan: agents, tools, schedule, approval gates
  4. User can edit each field (reuse `StrategyRosterEditor` for agents)
  5. User can refine via chat ("make the writer more casual", "add a legal review gate")
  6. User clicks "Create loop" → `POST /api/loop-builder/save`
  7. Redirects to `/dashboard/loops/[workflowId]`

### 4.2 Generic loop management page
- **New file:** `dashboard/app/dashboard/loops/[workflowId]/page.tsx`
- **Purpose:** Replaces the hardcoded `/dashboard/loops/newsletter` page
- **Shows:** Loop definition, schedule, last run status, run history, edit definition button

### 4.3 Content-aware run detail page
- **File:** `dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx`
- **Changes:**
  - Remove hardcoded "Newsletter" breadcrumb/title/badge — derive from `workflow.title`
  - Make the center panel content-type-aware:
    - Newsletter preset → show newsletter editor + email preview (existing)
    - Blog post preset → show markdown editor + preview
    - Report preset → show structured report viewer
    - Default → show raw markdown via `Streamdown` (existing)
  - Conditionally show/hide:
    - Email builder dialog (only if delivery type is email)
    - CSV upload (only if the plan has a recipient input gate)
    - Delivery stats (only if delivery type is broadcast)
  - Make approval CTAs generic: "Ready for approval" instead of "Newsletter is ready for approval"

### 4.4 Remove hardcoded newsletter card
- **File:** `dashboard/app/dashboard/loops/page.tsx`
- **Changes:**
  - Remove the hardcoded newsletter card injection (`hardcodedNewsletterLoop()`)
  - Remove `HARDCODED_NEWSLETTER_TASK`, `HARDCODED_NEWSLETTER_CRON`, `NEWSLETTER_ALLOWED_TOOL_REFS`
  - Remove `findLennyNewsletterWorkflow()`, `isExplicitLennyNewsletterLoop()`, `isAnyLennyNewsletterLoop()`
  - Add a "Create loop" button that navigates to `/dashboard/loops/new`
  - Make "Loop this" on mined loops actually call `POST /api/loop-builder/propose` with the mined pattern as context

---

## Phase 5: Polish & Benchmark

### 5.1 Newsletter as benchmark
- Keep the newsletter preset fully functional as a reference implementation
- Keep the existing React Email templates
- Keep the Resend broadcast delivery path
- The newsletter loop should work identically to today, but through the generic execution path

### 5.2 Connector-aware tool suggestions
- **File:** `src/services/loop-executor/intent-resolver.ts`
- **Enhancement:** When proposing a loop, check the user's connected Composio accounts and channels to suggest only available tools. E.g., if the user has Gmail connected but not Notion, suggest `composio.gmail.create_draft` but not `composio.notion.create_page`.

### 5.3 Memory-informed user turns
- **Enhancement:** The builder wizard should generate example "user turns" based on the user's memory:
  - Past writing style and tone preferences
  - Previous content topics and themes
  - Audience information
  - Recurring schedule patterns
- These become the agent `task` prompts and the CEO `policy` text.

---

## Execution Order & Dependencies

```
Phase 1 (Backend Decoupling)
  1.1 Remove admin gate
  1.2 Stop auto-detecting newsletter preset
  1.3 Extract tool dispatch registry        ← biggest refactor
  1.4 Extract delivery formatter registry
  1.5 Decouple gates from newsletter
  1.6 Generalize external_action
  1.7 Generalize approval/delivery flow
  1.8 Remove newsletter conditionals

Phase 2 (API Changes) — depends on Phase 1
  2.1 Public create endpoint
  2.2 Per-stage approval policy
  2.3 Channel-aware delivery

Phase 3 (AI Builder) — depends on Phase 2
  3.1 Intent resolver
  3.2 Builder wizard API
  3.3 Preset templates

Phase 4 (UI) — depends on Phase 2 + 3
  4.1 Loop creation wizard
  4.2 Generic loop management page
  4.3 Content-aware run detail page
  4.4 Remove hardcoded newsletter card

Phase 5 (Polish) — depends on all above
  5.1 Newsletter benchmark validation
  5.2 Connector-aware suggestions
  5.3 Memory-informed user turns
```

## Estimated Scope

| Phase | Files Changed | New Files | Complexity |
|-------|--------------|-----------|------------|
| 1. Backend Decoupling | 8 | 2 | High |
| 2. API Changes | 4 | 0 | Medium |
| 3. AI Builder | 1 | 5 | Medium |
| 4. UI | 3 | 2 | High |
| 5. Polish | 2 | 0 | Low |
| **Total** | **18** | **9** | — |

## Risk Mitigation

1. **Newsletter regression:** After each Phase 1 change, manually run a newsletter loop end-to-end and verify identical behavior.
2. **Data migration:** No schema changes needed. Existing `workflows` and `workflow_runs` rows are unaffected.
3. **Backward compatibility:** Keep `/internal/loops` endpoints working. The newsletter preset continues to work via explicit `presetId: "newsletter"`.
4. **Feature flag:** Gate Phase 3/4 behind a `config.loopBuilderEnabled` flag so the generic builder can be rolled out incrementally.
