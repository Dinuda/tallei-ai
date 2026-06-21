// Legacy graph-operator e2e scenarios below target the removed loop_engine_v3 runtime.
// Spec-driven runs show a placeholder while the chat run UI is rebuilt.

import { createHash, randomUUID } from "crypto";
import path from "node:path";

import { config as loadDotenv } from "dotenv";
import { encode } from "next-auth/jwt";
import { Pool } from "pg";

const repoRoot = process.cwd();
const dashboardRoot = path.join(repoRoot, "dashboard");

loadDotenv({ path: path.join(repoRoot, ".env") });
loadDotenv({ path: path.join(dashboardRoot, ".env.local"), override: true });

const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3000";
const internalSecret = process.env.INTERNAL_API_SECRET ?? "";
const nextAuthSecret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
const databaseUrl = process.env.TALLEI_DB__URL ?? process.env.DATABASE_URL ?? "";

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
});

type ScenarioName =
  | "input-start"
  | "input-start-satisfied"
  | "memory-confirmation"
  | "source-confirmation"
  | "draft-review-email"
  | "draft-review-preview"
  | "recipient-upload"
  | "pre-send"
  | "failed-recipient-recovery";

type AuthFixture = {
  userId: string;
  tenantId: string;
  email: string;
  sessionToken: string;
  cookie: {
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax";
  };
};

export type SeededLoopFixture = {
  scenario: ScenarioName;
  workflowId: string;
  runId: string;
  interactionId: string;
  stepAttemptId: string;
  title: string;
  url: string;
  auth: AuthFixture;
  artifactKey?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function futureIso(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function checkpointSurface(input: {
  key: string;
  surface: string;
  required?: boolean;
  satisfied?: boolean;
  label?: string;
  description?: string;
  props?: Record<string, unknown>;
}) {
  return {
    key: input.key,
    surface: input.surface,
    required: input.required ?? true,
    satisfied: input.satisfied ?? false,
    ...(input.label ? { label: input.label } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.props ? { props: input.props } : {}),
  };
}

function checkpointPayload(input: {
  reason: "missing_requirements" | "review" | "confirm_external_effect";
  blocking: { agentId: string; stepIndex: number };
  surfaces: ReturnType<typeof checkpointSurface>[];
  extra?: Record<string, unknown>;
}) {
  return {
    checkpoint: {
      reason: input.reason,
      blocking: input.blocking,
      surfaces: input.surfaces,
    },
    agentId: input.blocking.agentId,
    stepIndex: input.blocking.stepIndex,
    surfaces: input.surfaces,
    ...(input.extra ?? {}),
  };
}

function makeDefinition(input: {
  goal: string;
  child: {
    id: string;
    name: string;
    task: string;
    goal?: string;
    toolRef: string;
    gate?: { type: "memory_confirmation" | "source_confirmation" | "missing_input" | "draft_review" | "pre_send"; question: string };
    renderTarget?: "canvas.email" | "canvas.preview";
    outputArtifactId?: string;
  };
  delivery?: { provider: string; target: "subscriber_list" | "team_email" | "operator" | "none" };
  connectorPolicy?: {
    allowedWriteActions?: Array<{
      toolkit: string;
      actionSlug: string;
      risk: "read" | "write" | "send" | "destructive";
      description?: string;
      requiresPreSendApproval?: boolean;
    }>;
    recipientSource?: { kind: "none" | "configured" | "uploaded" | "operator_input" };
    deliveryExpectation?: string;
  };
  inputsRequired?: string[];
  inputRequirements?: Array<{
    key: string;
    surface: "input.text" | "input.markdown" | "input.contacts_csv" | "input.audience_id" | "input.file";
    when: "run_start" | "before_send" | "before_step";
    required: boolean;
  }>;
}) {
  const child = {
    id: input.child.id,
    name: input.child.name,
    task: input.child.task,
    ...(input.child.goal ? { goal: input.child.goal } : {}),
    tools: [{ ref: input.child.toolRef }],
    doneCriteria: ["Complete the assigned step."],
    ...(input.child.gate ? { gate: input.child.gate } : {}),
    ...(input.child.renderTarget ? { renderTarget: input.child.renderTarget } : {}),
    ...(input.child.outputArtifactId ? { outputArtifactId: input.child.outputArtifactId } : {}),
    outputArtifactKind: input.child.renderTarget ? "canvas_email" : "structured_output",
  };

  return {
    definitionVersion: "loop_executor_v2",
    engineVersion: "loop_engine_v3",
    goal: input.goal,
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    allowedIntegrations: ["internal", "composio"],
    ceo: {
      name: "Tallei Agent",
      task: `Coordinate the workflow: ${input.goal}`,
      policy: "Keep the queue moving and stop only at declared operator interactions.",
    },
    draftPolicy: {
      requireDraftBeforeExternalAction: true,
      approvalRequiredFor: ["publish", "send", "external_action"],
    },
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.connectorPolicy ? { connectorPolicy: input.connectorPolicy } : {}),
    ...(input.inputsRequired?.length ? { inputsRequired: input.inputsRequired } : {}),
    ...(input.inputRequirements?.length ? { inputRequirements: input.inputRequirements } : {}),
    agentGraph: {
      parent: {
        id: "parent_agent",
        name: "Tallei Agent",
        task: `Coordinate the workflow: ${input.goal}`,
        policy: "Keep the queue moving and stop only at declared operator interactions.",
        connectorHub: {
          provider: "composio",
          label: "Composio",
          description: "Connector hub for external delivery actions.",
        },
      },
      children: [child],
    },
  };
}

async function syncTestUser(email: string) {
  if (!internalSecret) throw new Error("INTERNAL_API_SECRET is not configured");
  const sub = `pw-${randomUUID()}`;
  const response = await fetch(`${backendUrl}/api/auth/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Internal-Secret": internalSecret,
    },
    body: JSON.stringify({ sub, email }),
  });
  const payload = await response.json().catch(() => ({})) as { userId?: string; tenantId?: string; error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Failed to sync test user (${response.status})`);
  }
  if (!payload.userId || !payload.tenantId) {
    throw new Error("Auth sync did not return a userId and tenantId");
  }

  const sessionToken = await encode({
    token: {
      backendId: payload.userId,
      backendPlan: "pro",
      name: email.split("@")[0],
      email,
      picture: "",
      sub: payload.userId,
    },
    secret: nextAuthSecret,
    salt: "authjs.session-token",
  });

  return {
    userId: payload.userId,
    tenantId: payload.tenantId,
    email,
    sessionToken,
    cookie: {
      name: "authjs.session-token",
      value: sessionToken,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
    },
  } satisfies AuthFixture;
}

async function insertWorkflow(input: {
  auth: AuthFixture;
  workflowId: string;
  title: string;
  definition: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO workflows
     (id, tenant_id, user_id, title, fingerprint, instruction, schedule_rrule, status, requires_connector, connector_provider, connector_scope_keys, metadata_json, definition_version, next_run_at, last_scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', FALSE, NULL, '[]'::jsonb, $8::jsonb, 'loop_executor_v2', $9::timestamptz, $10::timestamptz)`,
    [
      input.workflowId,
      input.auth.tenantId,
      input.auth.userId,
      input.title,
      `${input.workflowId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      String(input.definition.goal ?? input.title),
      "0 9 * * *",
      JSON.stringify({ source: "playwright-fixture", loopDefinition: input.definition }),
      futureIso(24),
      null,
    ],
  );
}

async function insertRun(input: {
  auth: AuthFixture;
  runId: string;
  workflowId: string;
  status: "waiting_for_interaction" | "running" | "failed";
  definition: Record<string, unknown>;
  context: Record<string, unknown>;
  errorMessage?: string;
}) {
  await pool.query(
    `INSERT INTO loop_engine_runs
     (id, tenant_id, user_id, workflow_id, status, definition_snapshot, context_json, current_step_index, error_json, started_at, finished_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 0, $8::jsonb, $9::timestamptz, $10::timestamptz, NOW(), NOW())`,
    [
      input.runId,
      input.auth.tenantId,
      input.auth.userId,
      input.workflowId,
      input.status,
      JSON.stringify(input.definition),
      JSON.stringify(input.context),
      JSON.stringify(input.errorMessage ? { message: input.errorMessage } : {}),
      nowIso(),
      input.status === "failed" ? nowIso() : null,
    ],
  );
}

async function insertStepAttempt(input: {
  auth: AuthFixture;
  runId: string;
  stepId: string;
  agentId: string;
  agentSnapshot: Record<string, unknown>;
  status: "waiting_for_interaction" | "failed" | "succeeded";
  outputText?: string;
  outputData?: Record<string, unknown>;
  errorMessage?: string;
}) {
  await pool.query(
    `INSERT INTO loop_engine_step_attempts
     (id, tenant_id, user_id, run_id, step_index, agent_id, agent_snapshot, attempt, status, input_json, output_json, error_json, started_at, finished_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6::jsonb, 1, $7, '{}'::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz, $11::timestamptz, NOW(), NOW())`,
    [
      input.stepId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.agentId,
      JSON.stringify(input.agentSnapshot),
      input.status,
      JSON.stringify({
        text: input.outputText ?? "",
        data: input.outputData ?? {},
      }),
      JSON.stringify(input.errorMessage ? { message: input.errorMessage } : {}),
      nowIso(),
      input.status === "failed" ? nowIso() : null,
    ],
  );
}

function typedInteractionKind(
  gateType: "memory_confirmation" | "source_confirmation" | "missing_input" | "draft_review" | "pre_send",
): "collect_input" | "review_artifact" {
  return gateType === "missing_input" ? "collect_input" : "review_artifact";
}

function buildTypedInteractionPayload(input: {
  gateType: "memory_confirmation" | "source_confirmation" | "missing_input" | "draft_review" | "pre_send";
  interactionId: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const surfaces = Array.isArray(input.payload.surfaces)
    ? input.payload.surfaces as Array<Record<string, unknown>>
    : [];
  const surface = surfaces[0] ?? {};
  const agentId = typeof input.payload.agentId === "string" ? input.payload.agentId : "agent";
  const outputText = typeof (input.payload.result as { text?: string } | undefined)?.text === "string"
    ? (input.payload.result as { text: string }).text
    : "";
  if (input.gateType === "missing_input" || (typeof surface.surface === "string" && surface.surface.startsWith("input."))) {
    const key = typeof surface.key === "string" ? surface.key : "required_input";
    const itemSurface = typeof surface.surface === "string" ? surface.surface : "input.text";
    return {
      ...input.payload,
      operatorInteraction: {
        kind: "collect_input",
        interactionIds: [input.interactionId],
        items: [{
          id: `required:${key}`,
          kind: "collect_input",
          requiredValueKey: key,
          consumingNodeId: agentId,
          surface: itemSurface,
          timing: typeof input.payload.when === "string" ? input.payload.when : "run_start",
          valueType: itemSurface === "input.contacts_csv" ? "array" : "string",
          label: typeof surface.label === "string" ? surface.label : key,
          description: typeof surface.description === "string" ? surface.description : `Provide ${key}.`,
          required: surface.required !== false,
          satisfied: surface.satisfied === true,
        }],
      },
    };
  }
  const props = surface.props && typeof surface.props === "object" && !Array.isArray(surface.props)
    ? surface.props as Record<string, unknown>
    : {};
  const renderTarget = typeof props.renderTarget === "string"
    ? props.renderTarget
    : typeof input.payload.renderTarget === "string"
      ? input.payload.renderTarget
      : null;
  const artifactId = typeof surface.key === "string" ? surface.key : `${agentId}_output`;
  return {
    ...input.payload,
    gateType: input.gateType,
    operatorInteraction: {
      kind: "review_artifact",
      interactionId: input.interactionId,
      artifactId,
      rendererRef: input.gateType === "draft_review" || input.gateType === "pre_send" ? renderTarget : null,
      editable: input.gateType === "draft_review" && renderTarget === "canvas.email",
      producerNodeId: agentId,
      outputText,
    },
  };
}

async function insertGate(input: {
  auth: AuthFixture;
  runId: string;
  stepId: string;
  interactionId: string;
  gateType: "memory_confirmation" | "source_confirmation" | "missing_input" | "draft_review" | "pre_send";
  status: "pending" | "approved" | "submitted" | "rejected";
  question: string;
  payload: Record<string, unknown>;
}) {
  const interactionKind = typedInteractionKind(input.gateType);
  const payload = buildTypedInteractionPayload({
    gateType: input.gateType,
    interactionId: input.interactionId,
    payload: input.payload,
  });
  await pool.query(
    `INSERT INTO loop_engine_interactions
     (id, tenant_id, user_id, run_id, step_attempt_id, interaction_kind, status, question, payload_json, decision_json, idempotency_key, completed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb, $10, $11::timestamptz, NOW(), NOW())`,
    [
      input.interactionId,
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepId,
      interactionKind,
      input.status,
      input.question,
      JSON.stringify(payload),
      `fixture:${input.runId}:${input.gateType}`,
      input.status === "pending" ? null : nowIso(),
    ],
  );
}

async function insertArtifact(input: {
  auth: AuthFixture;
  runId: string;
  stepId: string;
  artifactKey: string;
  kind: "canvas_email" | "canvas_preview" | "structured_output";
  body: string;
  dataJson: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO loop_engine_artifacts
     (id, tenant_id, user_id, run_id, step_attempt_id, artifact_key, version, kind, body, data_json, invalidated_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9::jsonb, NULL, NOW())`,
    [
      randomUUID(),
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepId,
      input.artifactKey,
      input.kind,
      input.body,
      JSON.stringify(input.dataJson),
    ],
  );
}

function baseAgentSnapshot(input: {
  id: string;
  name: string;
  task: string;
  toolRef: string;
  gate?: { type: string; question: string };
  renderTarget?: "canvas.email" | "canvas.preview";
  outputArtifactId?: string;
}) {
  return {
    id: input.id,
    name: input.name,
    task: input.task,
    tools: [{ ref: input.toolRef }],
    gate: input.gate ? { type: input.gate.type, question: input.gate.question } : undefined,
    ...(input.renderTarget ? { renderTarget: input.renderTarget } : {}),
    ...(input.outputArtifactId ? { outputArtifactId: input.outputArtifactId } : {}),
  };
}

async function seedInputStartFixture(auth: AuthFixture, satisfied = false): Promise<Omit<SeededLoopFixture, "auth">> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const interactionId = randomUUID();
  const title = satisfied ? "Sprint input already saved" : "Sprint input required";
  const definition = makeDefinition({
    goal: "Capture sprint notes before drafting begins",
    inputsRequired: ["sprint_notes"],
    child: {
      id: "input_validator",
      name: "Input Validator Agent",
      task: "Ask for the missing sprint notes and wait for the operator.",
      goal: "Validate the presence of sprint notes.",
      toolRef: "internal.llm_only",
      gate: {
        type: "missing_input",
        question: "Paste sprint notes before drafting begins.",
      },
    },
  });
  const surface = checkpointSurface({
    key: "sprint_notes",
    surface: "input.markdown",
    label: "Sprint Notes",
    description: "Paste sprint notes before drafting begins.",
    satisfied,
  });
  await insertWorkflow({ auth, workflowId, title, definition });
  await insertRun({
    auth,
    runId,
    workflowId,
    status: "waiting_for_interaction",
    definition,
    context: satisfied ? { inputs: { sprint_notes: "Sprint notes already captured." }, approvedMemories: [], approvedSources: {}, operatorRevisions: {} } : { inputs: {}, approvedMemories: [], approvedSources: {}, operatorRevisions: {} },
  });
  await insertStepAttempt({
    auth,
    runId,
    stepId,
    agentId: "input_validator",
    agentSnapshot: baseAgentSnapshot({
      id: "input_validator",
      name: "Input Validator Agent",
      task: "Ask for the missing sprint notes and wait for the operator.",
      toolRef: "internal.llm_only",
      gate: { type: "missing_input", question: "Paste sprint notes before drafting begins." },
    }),
    status: "waiting_for_interaction",
    outputText: "Paste the missing input below to continue.",
  });
  await insertGate({
    auth,
    runId,
    stepId,
    interactionId,
    gateType: "missing_input",
    status: "pending",
    question: "Paste sprint notes before drafting begins.",
    payload: checkpointPayload({
      reason: "missing_requirements",
      blocking: { agentId: "input_validator", stepIndex: 0 },
      surfaces: [surface],
      extra: { when: "run_start" },
    }),
  });
  return { scenario: satisfied ? "input-start-satisfied" : "input-start", workflowId, runId, interactionId, stepAttemptId: stepId, title, url: `/dashboard/loops/${workflowId}/runs/${runId}` };
}

async function seedMemoryFixture(auth: AuthFixture): Promise<Omit<SeededLoopFixture, "auth">> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const interactionId = randomUUID();
  const title = "Memory confirmation";
  const definition = makeDefinition({
    goal: "Choose which memories should be passed to the writer",
    child: {
      id: "memory_searcher",
      name: "Memory Searcher",
      task: "Ask the operator which memories should be used.",
      goal: "Select memories for the next step.",
      toolRef: "internal.memory_search",
      gate: {
        type: "memory_confirmation",
        question: "Select which memories the next agent may use.",
      },
    },
  });
  const items = [
    { id: "mem_1", excerpt: "Sprint notes say the release moved to Friday.", include: true, evidenceRole: "supporting" },
    { id: "mem_2", excerpt: "Customer requested a shorter summary.", include: true, evidenceRole: "context" },
    { id: "mem_3", excerpt: "Old placeholder memory that should be excluded.", include: false, evidenceRole: "noise" },
  ];
  const surface = checkpointSurface({
    key: "approved_memories",
    surface: "review.memories",
    label: "Memories",
    description: "Select which memories the next agent may use.",
  });
  await insertWorkflow({ auth, workflowId, title, definition });
  await insertRun({
    auth,
    runId,
    workflowId,
    status: "waiting_for_interaction",
    definition,
    context: { inputs: {}, approvedMemories: [], approvedSources: {}, operatorRevisions: {} },
  });
  await insertStepAttempt({
    auth,
    runId,
    stepId,
    agentId: "memory_searcher",
    agentSnapshot: baseAgentSnapshot({
      id: "memory_searcher",
      name: "Memory Searcher",
      task: "Ask the operator which memories should be used.",
      toolRef: "internal.memory_search",
      gate: { type: "memory_confirmation", question: "Select which memories the next agent may use." },
    }),
    status: "waiting_for_interaction",
    outputText: "Relevant memories found.",
    outputData: { sources: items.map((item) => ({ id: item.id, text: item.excerpt })) },
  });
  await insertGate({
    auth,
    runId,
    stepId,
    interactionId,
    gateType: "memory_confirmation",
    status: "pending",
    question: "Select which memories the next agent may use.",
    payload: checkpointPayload({
      reason: "review",
      blocking: { agentId: "memory_searcher", stepIndex: 0 },
      surfaces: [surface],
      extra: { items, result: { text: "Relevant memories found." } },
    }),
  });
  return { scenario: "memory-confirmation", workflowId, runId, interactionId, stepAttemptId: stepId, title, url: `/dashboard/loops/${workflowId}/runs/${runId}` };
}

async function seedSourceFixture(auth: AuthFixture): Promise<Omit<SeededLoopFixture, "auth">> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const interactionId = randomUUID();
  const title = "Source confirmation";
  const definition = makeDefinition({
    goal: "Approve the web sources before drafting",
    child: {
      id: "source_searcher",
      name: "Source Searcher",
      task: "Collect source candidates and wait for approval.",
      goal: "Select web sources.",
      toolRef: "internal.web_search",
      gate: {
        type: "source_confirmation",
        question: "Select sources, add custom URLs, then approve or revise.",
      },
    },
  });
  const items = [
    { id: "https://example.com/source-one", title: "Source one", url: "https://example.com/source-one", snippet: "First source snippet.", include: true },
    { id: "https://example.com/source-two", title: "Source two", url: "https://example.com/source-two", snippet: "Second source snippet.", include: true },
  ];
  const surface = checkpointSurface({
    key: "approved_sources",
    surface: "review.sources",
    label: "Sources",
    description: "Select sources, add custom URLs, then approve or revise.",
  });
  await insertWorkflow({ auth, workflowId, title, definition });
  await insertRun({
    auth,
    runId,
    workflowId,
    status: "waiting_for_interaction",
    definition,
    context: { inputs: {}, approvedMemories: [], approvedSources: {}, operatorRevisions: {} },
  });
  await insertStepAttempt({
    auth,
    runId,
    stepId,
    agentId: "source_searcher",
    agentSnapshot: baseAgentSnapshot({
      id: "source_searcher",
      name: "Source Searcher",
      task: "Collect source candidates and wait for approval.",
      toolRef: "internal.web_search",
      gate: { type: "source_confirmation", question: "Select sources, add custom URLs, then approve or revise." },
    }),
    status: "waiting_for_interaction",
    outputText: "Source candidates ready.",
    outputData: { sources: items.map((item) => ({ id: item.id, text: item.snippet })) },
  });
  await insertGate({
    auth,
    runId,
    stepId,
    interactionId,
    gateType: "source_confirmation",
    status: "pending",
    question: "Select sources, add custom URLs, then approve or revise.",
    payload: checkpointPayload({
      reason: "review",
      blocking: { agentId: "source_searcher", stepIndex: 0 },
      surfaces: [surface],
      extra: { items, result: { text: "Source candidates ready." } },
    }),
  });
  return { scenario: "source-confirmation", workflowId, runId, interactionId, stepAttemptId: stepId, title, url: `/dashboard/loops/${workflowId}/runs/${runId}` };
}

async function seedDraftFixture(auth: AuthFixture, renderTarget: "canvas.email" | "canvas.preview"): Promise<Omit<SeededLoopFixture, "auth">> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const interactionId = randomUUID();
  const title = renderTarget === "canvas.email" ? "Draft review email" : "Draft review preview";
  const artifactKey = renderTarget === "canvas.email" ? "draft_email:canvas.email" : "draft_preview:canvas.email";
  const definition = makeDefinition({
    goal: renderTarget === "canvas.email"
      ? "Review the editable email draft before approval"
      : "Review the read-only email preview before approval",
    child: {
      id: renderTarget === "canvas.email" ? "email_writer" : "preview_writer",
      name: renderTarget === "canvas.email" ? "Email Writer" : "Preview Writer",
      task: "Write the draft and pause for review.",
      goal: "Produce a reviewable email draft.",
      toolRef: "internal.llm_only",
      gate: {
        type: "draft_review",
        question: "Review the draft, then save & approve or request changes.",
      },
      renderTarget,
      outputArtifactId: artifactKey.replace(/:canvas\.email$/, ""),
    },
  });
  const surface = checkpointSurface({
    key: renderTarget === "canvas.email" ? "email_draft" : "preview_draft",
    surface: "review.email",
    label: "Email",
    description: "Review the email draft, then save & approve or request changes.",
    props: { renderTarget, canvasArtifactKey: artifactKey },
  });
  await insertWorkflow({ auth, workflowId, title, definition });
  await insertRun({
    auth,
    runId,
    workflowId,
    status: "waiting_for_interaction",
    definition,
    context: { inputs: {}, approvedMemories: [], approvedSources: {}, operatorRevisions: {} },
  });
  await insertStepAttempt({
    auth,
    runId,
    stepId,
    agentId: definition.agentGraph.children[0]!.id,
    agentSnapshot: baseAgentSnapshot({
      id: definition.agentGraph.children[0]!.id,
      name: definition.agentGraph.children[0]!.name,
      task: definition.agentGraph.children[0]!.task,
      toolRef: "internal.llm_only",
      gate: { type: "draft_review", question: "Review the draft, then save & approve or request changes." },
      renderTarget,
      outputArtifactId: artifactKey.replace(/:canvas\.email$/, ""),
    }),
    status: "waiting_for_interaction",
    outputText: renderTarget === "canvas.email"
      ? "Subject: Sprint update\n\nDraft body ready for review."
      : "Preview body ready for review.",
  });
  await insertArtifact({
    auth,
    runId,
    stepId,
    artifactKey,
    kind: renderTarget === "canvas.email" ? "canvas_email" : "canvas_preview",
    body: renderTarget === "canvas.email"
      ? "<html><body><h1>Sprint update</h1><p>Draft body ready for review.</p></body></html>"
      : "<html><body><h1>Preview</h1><p>Preview body ready for review.</p></body></html>",
    dataJson: {
      renderTarget,
      ...(renderTarget === "canvas.preview" ? { canvas_state: "preview" } : {}),
      emailTemplate: {
        design: { variant: renderTarget },
        html: renderTarget === "canvas.email"
          ? "<html><body><h1>Sprint update</h1><p>Draft body ready for review.</p></body></html>"
          : "<html><body><h1>Preview</h1><p>Preview body ready for review.</p></body></html>",
        text: "Sprint update\n\nDraft body ready for review.",
        subject: "Sprint update",
        preview: "Sprint update",
        source: "playwright-fixture",
      },
    },
  });
  await insertGate({
    auth,
    runId,
    stepId,
    interactionId,
    gateType: "draft_review",
    status: "pending",
    question: "Review the draft, then save & approve or request changes.",
    payload: checkpointPayload({
      reason: "review",
      blocking: { agentId: definition.agentGraph.children[0]!.id, stepIndex: 0 },
      surfaces: [surface],
      extra: { renderTarget, canvasArtifactKey: artifactKey, result: { text: "Draft ready for review." } },
    }),
  });
  return { scenario: renderTarget === "canvas.email" ? "draft-review-email" : "draft-review-preview", workflowId, runId, interactionId, stepAttemptId: stepId, artifactKey, title, url: `/dashboard/loops/${workflowId}/runs/${runId}` };
}

async function seedRecipientUploadFixture(auth: AuthFixture, savedContacts: boolean): Promise<Omit<SeededLoopFixture, "auth">> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const interactionId = randomUUID();
  const title = savedContacts ? "Recipient upload with saved contacts" : "Recipient upload";
  const definition = makeDefinition({
    goal: "Collect recipients before delivery",
    child: {
      id: "recipient_gate",
      name: "Recipient Interaction",
      task: "Collect recipients and continue.",
      goal: "Save recipients before continuing.",
      toolRef: "internal.llm_only",
      gate: {
        type: "pre_send",
        question: "Upload or paste recipients before sending.",
      },
    },
    inputRequirements: [{
      key: "recipients",
      surface: "input.contacts_csv",
      when: "before_send",
      required: true,
    }],
  });
  const surface = checkpointSurface({
    key: "recipients",
    surface: "input.contacts_csv",
    label: "Recipients",
    description: "Upload or paste recipients before sending.",
    satisfied: savedContacts,
  });
  await insertWorkflow({ auth, workflowId, title, definition });
  await insertRun({
    auth,
    runId,
    workflowId,
    status: "waiting_for_interaction",
    definition,
    context: savedContacts
      ? {
          inputs: {},
          deliveryRecipients: {
            uploadedAt: nowIso(),
            contacts: [
              { email: "alex@example.com", name: "Alex" },
              { email: "casey@example.com", name: "Casey" },
            ],
            recipientCount: 2,
            source: "uploaded",
          },
          approvedMemories: [],
          approvedSources: {},
          operatorRevisions: {},
        }
      : { inputs: {}, approvedMemories: [], approvedSources: {}, operatorRevisions: {} },
  });
  await insertStepAttempt({
    auth,
    runId,
    stepId,
    agentId: "recipient_gate",
    agentSnapshot: baseAgentSnapshot({
      id: "recipient_gate",
      name: "Recipient Interaction",
      task: "Collect recipients and continue.",
      toolRef: "internal.llm_only",
      gate: { type: "pre_send", question: "Upload or paste recipients before sending." },
    }),
    status: "waiting_for_interaction",
    outputText: "Recipient list required.",
  });
  await insertGate({
    auth,
    runId,
    stepId,
    interactionId,
    gateType: "missing_input",
    status: "pending",
    question: "Upload or paste recipients before sending.",
    payload: checkpointPayload({
      reason: "missing_requirements",
      blocking: { agentId: "recipient_gate", stepIndex: 0 },
      surfaces: [surface],
      extra: { when: "before_send", uiBlocks: [{ type: "contacts_upload", required: true, mode: "uploaded" }], recipientStatus: savedContacts ? "ready" : "missing" },
    }),
  });
  return { scenario: "recipient-upload", workflowId, runId, interactionId, stepAttemptId: stepId, title, url: `/dashboard/loops/${workflowId}/runs/${runId}` };
}

async function seedPreSendFixture(auth: AuthFixture): Promise<Omit<SeededLoopFixture, "auth">> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const interactionId = randomUUID();
  const title = "Pre-send approval";
  const deliveryAction = "composio.resend.action.resend_send_email";
  const definition = makeDefinition({
    goal: "Approve the outbound send before delivery",
    delivery: {
      provider: deliveryAction,
      target: "subscriber_list",
    },
    connectorPolicy: {
      allowedWriteActions: [{
        toolkit: "resend",
        actionSlug: "resend_send_email",
        risk: "send",
        requiresPreSendApproval: true,
        description: "Send the newsletter email.",
      }],
      recipientSource: { kind: "uploaded" },
      deliveryExpectation: "Send a newsletter email to the uploaded recipients.",
    },
    child: {
      id: "send_agent",
      name: "Send Agent",
      task: "Prepare the approved send and wait for final confirmation.",
      goal: "Review the send payload and wait for approval.",
      toolRef: deliveryAction,
      gate: {
        type: "pre_send",
        question: "Approve the final send payload.",
      },
      renderTarget: "canvas.email",
      outputArtifactId: "send_agent_output",
    },
  });
  const surface = checkpointSurface({
    key: "confirm_send",
    surface: "confirm.send",
    label: "Send",
    description: "Review the final draft, then approve send.",
    props: { renderTarget: "canvas.email", canvasArtifactKey: "send_agent_output:canvas.email" },
  });
  const payload = {
    subject: "Final send",
    content: "Ready for approval.",
    recipients: ["alex@example.com", "casey@example.com"],
  };
  const specSnapshot = null;
  await insertWorkflow({ auth, workflowId, title, definition });
  await insertRun({
    auth,
    runId,
    workflowId,
    status: "waiting_for_interaction",
    definition,
    context: {
      inputs: {},
      deliveryRecipients: {
        uploadedAt: nowIso(),
        contacts: [
          { email: "alex@example.com", name: "Alex" },
          { email: "casey@example.com", name: "Casey" },
        ],
        recipientCount: 2,
        source: "uploaded",
      },
      approvedMemories: [],
      approvedSources: {},
      operatorRevisions: {},
    },
  });
  await insertStepAttempt({
    auth,
    runId,
    stepId,
    agentId: "send_agent",
    agentSnapshot: baseAgentSnapshot({
      id: "send_agent",
      name: "Send Agent",
      task: "Prepare the approved send and wait for final confirmation.",
      toolRef: deliveryAction,
      gate: { type: "pre_send", question: "Approve the final send payload." },
      renderTarget: "canvas.email",
      outputArtifactId: "send_agent_output",
    }),
    status: "waiting_for_interaction",
    outputText: "Final send payload is ready.",
  });
  await insertArtifact({
    auth,
    runId,
    stepId,
    artifactKey: "send_agent_output:canvas.email",
    kind: "canvas_email",
    body: "<html><body><h1>Final send</h1><p>Ready for approval.</p></body></html>",
    dataJson: {
      renderTarget: "canvas.email",
      emailTemplate: {
        design: { variant: "send" },
        html: "<html><body><h1>Final send</h1><p>Ready for approval.</p></body></html>",
        text: "Final send\n\nReady for approval.",
        subject: "Final send",
        preview: "Final send",
        source: "playwright-fixture",
      },
    },
  });
  await insertGate({
    auth,
    runId,
    stepId,
    interactionId,
    gateType: "pre_send",
    status: "pending",
    question: "Approve the final send payload.",
    payload: checkpointPayload({
      reason: "confirm_external_effect",
      blocking: { agentId: "send_agent", stepIndex: 0 },
      surfaces: [surface],
      extra: {
        kind: "connector_action",
        provider: "composio",
        toolkit: "resend",
        actionSlug: "resend_send_email",
        toolRef: deliveryAction,
        actionRisk: "send",
        recipientStatus: "ready",
        recipientCount: 2,
        uiBlocks: [],
        delivery: { provider: deliveryAction, target: "subscriber_list" },
        payload,
        payloadHash: sha256Json(payload),
        specHash: sha256Json(specSnapshot),
        summary: { subject: "Final send", preview: "Ready for approval.", recipientCount: 2 },
      },
    }),
  });
  return { scenario: "pre-send", workflowId, runId, interactionId, stepAttemptId: stepId, artifactKey: "send_agent_output:canvas.email", title, url: `/dashboard/loops/${workflowId}/runs/${runId}` };
}

async function seedFailedRecipientRecoveryFixture(auth: AuthFixture): Promise<Omit<SeededLoopFixture, "auth">> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const interactionId = randomUUID();
  const title = "Failed recipient recovery";
  const definition = makeDefinition({
    goal: "Recover from a missing recipient failure",
    delivery: {
      provider: "composio.resend.action.resend_send_email",
      target: "subscriber_list",
    },
    connectorPolicy: {
      allowedWriteActions: [{
        toolkit: "resend",
        actionSlug: "resend_send_email",
        risk: "send",
        requiresPreSendApproval: true,
        description: "Send the newsletter email.",
      }],
      recipientSource: { kind: "uploaded" },
      deliveryExpectation: "Send a newsletter email to the uploaded recipients.",
    },
    child: {
      id: "send_agent",
      name: "Send Agent",
      task: "Attempt the delivery and fail because recipients are missing.",
      goal: "Show the failure recovery state.",
      toolRef: "composio.resend.action.resend_send_email",
      gate: {
        type: "pre_send",
        question: "Approve the final send payload.",
      },
      renderTarget: "canvas.email",
      outputArtifactId: "send_agent_output",
    },
  });
  await insertWorkflow({ auth, workflowId, title, definition });
  await insertRun({
    auth,
    runId,
    workflowId,
    status: "failed",
    definition,
    context: {
      inputs: {},
      approvedMemories: [],
      approvedSources: {},
      operatorRevisions: {},
    },
    errorMessage: "Upload or paste at least one recipient before approving send.",
  });
  await insertStepAttempt({
    auth,
    runId,
    stepId,
    agentId: "send_agent",
    agentSnapshot: baseAgentSnapshot({
      id: "send_agent",
      name: "Send Agent",
      task: "Attempt the delivery and fail because recipients are missing.",
      toolRef: "composio.resend.action.resend_send_email",
      gate: { type: "pre_send", question: "Approve the final send payload." },
      renderTarget: "canvas.email",
      outputArtifactId: "send_agent_output",
    }),
    status: "failed",
    outputText: "Upload or paste at least one recipient before approving send.",
    errorMessage: "Upload or paste at least one recipient before approving send.",
  });
  await insertGate({
    auth,
    runId,
    stepId,
    interactionId,
    gateType: "pre_send",
    status: "rejected",
    question: "Approve the final send payload.",
    payload: checkpointPayload({
      reason: "confirm_external_effect",
      blocking: { agentId: "send_agent", stepIndex: 0 },
      surfaces: [checkpointSurface({
        key: "confirm_send",
        surface: "confirm.send",
        label: "Send",
        description: "Review the final draft, then approve send.",
        props: { renderTarget: "canvas.email", canvasArtifactKey: "send_agent_output:canvas.email" },
      })],
      extra: {
        kind: "connector_action",
        provider: "composio",
        toolkit: "resend",
        actionSlug: "resend_send_email",
        toolRef: "composio.resend.action.resend_send_email",
        actionRisk: "send",
        recipientStatus: "missing",
        recipientCount: 0,
        uiBlocks: [{ type: "contacts_upload", required: true, mode: "uploaded" }],
        delivery: { provider: "composio.resend.action.resend_send_email", target: "subscriber_list" },
        payload: {
          subject: "Final send",
          content: "Ready for approval.",
        },
        payloadHash: "fixture-payload-hash",
        specHash: "fixture-spec-hash",
        summary: { subject: "Final send", preview: "Ready for approval.", recipientCount: 0 },
        lastError: "Upload or paste at least one recipient before approving send.",
      },
    }),
  });
  return { scenario: "failed-recipient-recovery", workflowId, runId, interactionId, stepAttemptId: stepId, title, url: `/dashboard/loops/${workflowId}/runs/${runId}` };
}

export async function seedLoopRunFixture(scenario: ScenarioName): Promise<SeededLoopFixture> {
  if (!nextAuthSecret) throw new Error("NEXTAUTH_SECRET is not configured");
  const email = `${scenario}.${randomUUID().slice(0, 8)}@example.com`;
  const auth = await syncTestUser(email);

  let seeded: Omit<SeededLoopFixture, "auth">;
  switch (scenario) {
    case "input-start":
      seeded = await seedInputStartFixture(auth, false);
      break;
    case "input-start-satisfied":
      seeded = await seedInputStartFixture(auth, true);
      break;
    case "memory-confirmation":
      seeded = await seedMemoryFixture(auth);
      break;
    case "source-confirmation":
      seeded = await seedSourceFixture(auth);
      break;
    case "draft-review-email":
      seeded = await seedDraftFixture(auth, "canvas.email");
      break;
    case "draft-review-preview":
      seeded = await seedDraftFixture(auth, "canvas.preview");
      break;
    case "recipient-upload":
      seeded = await seedRecipientUploadFixture(auth, false);
      break;
    case "pre-send":
      seeded = await seedPreSendFixture(auth);
      break;
    case "failed-recipient-recovery":
      seeded = await seedFailedRecipientRecoveryFixture(auth);
      break;
    default:
      throw new Error(`Unknown fixture scenario: ${scenario}`);
  }

  return {
    ...seeded,
    scenario,
    auth,
  };
}

export async function closeLoopFixtureDb(): Promise<void> {
  await pool.end();
}

export function authCookieValue(auth: AuthFixture) {
  return auth.cookie;
}
