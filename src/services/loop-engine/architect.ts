/**
 * Model-owned planning with contract-only deterministic compilation.
 */

import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { listPreferences } from "../memory.js";
import { buildLoopDefinitionFromCeoDesign } from "../loop-executor/creator.js";
import { getEffectiveLoopConstraints, validateAgentRoster } from "../loop-executor/tool-catalog.js";
import {
  LOOP_ENGINE_VERSION,
  loopAgentGraphSchema,
  loopStageApprovalChannelInputSchema,
  type LoopDefinition,
  type LoopStageApprovalChannel,
} from "../loop-executor/types.js";
import { loopBuilderOpenAiChat, loopBuilderOpenAiModel } from "../loop-builder/openai-chat.js";
import {
  type LoopArchitectOutput,
  type NoSlopSpecSnapshot,
  type WorkflowCriticResult,
} from "./contracts.js";
import {
  compileLoopPlanningIR,
  loopPlanningIRJsonSchemaForContracts,
  loopPlanningIRSchema,
  type LoopPlanningIR,
  type PlanningCompilationIssue,
} from "./planning-ir.js";
import { formatMemoriesForArchitect, recallForDesigner } from "./recall.js";
import { formatWorkflowUserProfile, loadWorkflowUserProfile } from "./workflow-user-profile.js";
import {
  buildToolSpecRegistry,
  discoverToolsForQueries,
  discoveryQueriesForRequiredActions,
  inferRequiredConnectorActions,
  mergeRequiredToolContracts,
} from "../tool-spec/index.js";
import type { ToolContract } from "../tool-spec/types.js";
import { estimateLoopBuilderCostUsd, reportLoopBuilderProgress } from "../loop-builder/progress.js";

export type DesignerTestOverrides = {
  chat?: typeof loopBuilderOpenAiChat;
  recallForDesigner?: typeof recallForDesigner;
  listPreferences?: typeof listPreferences;
};

const loopBuilderTraceStageSchema = z.object({
  stage: z.string().min(1),
  model: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  output: z.record(z.unknown()).optional(),
});

export const loopBuilderTraceSchema = z.object({
  stages: z.array(loopBuilderTraceStageSchema).default([]),
});

export type LoopBuilderTrace = z.infer<typeof loopBuilderTraceSchema>;

export type DesignLoopInput = {
  auth: AuthContext;
  prompt: string;
  feedback?: string;
  noSlopSpec?: NoSlopSpecSnapshot;
  priorProposal?: {
    title: string;
    summary: string;
    definition: { builderMeta?: { planningIR?: unknown } };
    rationale: string[];
  };
  testOverrides?: DesignerTestOverrides;
};

const toolSearchPlanSchema = z.object({
  queries: z.array(z.string().min(1)).max(4).default([]),
});
const toolSearchPlanJsonSchema = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
    },
  },
  required: ["queries"],
  additionalProperties: false,
} as const;

const DEFAULT_MAX_PLANNING_CORRECTIONS = 1;
const DEFAULT_PLANNING_ATTEMPT_TIMEOUT_MS = 180_000;
const DEFAULT_PLANNING_MAX_COMPLETION_TOKENS = 8_000;
const DEFAULT_PLANNING_EMPTY_RESPONSE_RETRY_TOKENS = 12_000;
const DEFAULT_PLANNING_MAX_PROMPT_BYTES = 120_000;

export type PlanningAttemptResult = {
  attempt: number;
  kind: "initial" | "correction";
  durationMs: number;
  issueFingerprint: string;
  issueCountBefore: number;
  issueCountAfter: number;
  resolvedIssues: PlanningCompilationIssue[];
  introducedIssues: PlanningCompilationIssue[];
  repeatedIssues: PlanningCompilationIssue[];
  promptTokens: number;
  completionTokens: number;
  promptBytes: number;
  promptBreakdown: Record<string, number>;
  estimatedCostUsd: number;
  stopReason?: "compiled" | "structural_failure" | "attempt_failed" | "repeated_issues" | "worsened" | "correction_limit";
};

function readBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function planningProgressConfig() {
  return {
    maxCorrectionAttempts: readBoundedInteger(
      "TALLEI_LOOP_BUILDER__MAX_PLANNING_CORRECTIONS",
      DEFAULT_MAX_PLANNING_CORRECTIONS,
      0,
      1,
    ),
    attemptTimeoutMs: readBoundedInteger(
      "TALLEI_LOOP_BUILDER__PLANNING_ATTEMPT_TIMEOUT_MS",
      DEFAULT_PLANNING_ATTEMPT_TIMEOUT_MS,
      5_000,
      300_000,
    ),
    maxCompletionTokens: readBoundedInteger(
      "TALLEI_LOOP_BUILDER__PLANNING_MAX_COMPLETION_TOKENS",
      DEFAULT_PLANNING_MAX_COMPLETION_TOKENS,
      1_000,
      12_000,
    ),
    emptyResponseRetryMaxTokens: readBoundedInteger(
      "TALLEI_LOOP_BUILDER__PLANNING_EMPTY_RESPONSE_RETRY_TOKENS",
      DEFAULT_PLANNING_EMPTY_RESPONSE_RETRY_TOKENS,
      4_000,
      16_000,
    ),
    maxPromptBytes: readBoundedInteger(
      "TALLEI_LOOP_BUILDER__PLANNING_MAX_PROMPT_BYTES",
      DEFAULT_PLANNING_MAX_PROMPT_BYTES,
      20_000,
      500_000,
    ),
  };
}

function issueIdentity(issue: PlanningCompilationIssue): string {
  return `${issue.code}:${issue.path ?? ""}`;
}

export function planningIssueFingerprint(issues: PlanningCompilationIssue[]): string {
  return [...new Set(issues.map(issueIdentity))].sort().join("|");
}

function comparePlanningIssues(
  previous: PlanningCompilationIssue[],
  current: PlanningCompilationIssue[],
): Pick<PlanningAttemptResult, "resolvedIssues" | "introducedIssues" | "repeatedIssues"> {
  const previousIds = new Set(previous.map(issueIdentity));
  const currentIds = new Set(current.map(issueIdentity));
  return {
    resolvedIssues: previous.filter((issue) => !currentIds.has(issueIdentity(issue))),
    introducedIssues: current.filter((issue) => !previousIds.has(issueIdentity(issue))),
    repeatedIssues: current.filter((issue) => previousIds.has(issueIdentity(issue))),
  };
}

export function planningAttemptStopReason(input: {
  previousIssues: PlanningCompilationIssue[];
  currentIssues: PlanningCompilationIssue[];
  correction: boolean;
  lastAttempt: boolean;
}): PlanningAttemptResult["stopReason"] | undefined {
  if (input.currentIssues.length === 0) return "compiled";
  if (
    input.correction
    && planningIssueFingerprint(input.previousIssues) === planningIssueFingerprint(input.currentIssues)
  ) {
    return "repeated_issues";
  }
  const comparison = comparePlanningIssues(input.previousIssues, input.currentIssues);
  if (
    input.correction
    && input.currentIssues.length > input.previousIssues.length
    && comparison.resolvedIssues.length === 0
  ) {
    return "worsened";
  }
  return input.lastAttempt ? "correction_limit" : undefined;
}

export function shouldRetryPlanningTransportFailure(input: {
  structuralFailure: boolean;
  attempt: number;
  maxPlanningAttempts: number;
  transportFailures: number;
}): boolean {
  return !input.structuralFailure
    && input.attempt < input.maxPlanningAttempts - 1
    && input.transportFailures < 1;
}

class InvalidPlanningIRProposalError extends Error {
  constructor(
    message: string,
    readonly proposal?: Record<string, unknown>,
    readonly issues: PlanningCompilationIssue[] = [],
  ) {
    super(message);
    this.name = "InvalidPlanningIRProposalError";
  }
}

function formatPlanningValidationIssues(error: z.ZodError): PlanningCompilationIssue[] {
  return error.issues.map((issue) => ({
    code: "invalid_planning_ir",
    path: issue.path.length > 0 ? issue.path.join(".") : undefined,
    message: `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
  }));
}

function parseObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Planner returned a non-object JSON value.");
  }
  return parsed as Record<string, unknown>;
}

function schemaFields(schema: Record<string, unknown>, base = "", parentRequired = true): Array<{
  path: string;
  type: string;
  required: boolean;
  description: string | null;
}> {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  return Object.entries(properties).flatMap(([key, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const field = raw as Record<string, unknown>;
    const path = `${base}/${key}`;
    const type = typeof field.type === "string" ? field.type : "unknown";
    const row = {
      path,
      type,
      required: parentRequired && required.has(key),
      description: typeof field.description === "string" ? field.description : null,
    };
    const nested = type === "object" ? schemaFields(field, path, row.required) : [];
    return nested.length > 0 ? [row, ...nested] : [row];
  });
}

export function compactPlannerContracts(contracts: ToolContract[]) {
  return contracts.map((contract) => ({
    contractRef: contract.toolRef,
    name: contract.name,
    description: contract.description,
    provider: contract.provider,
    inputFields: schemaFields(contract.inputSchema).slice(0, 40),
    outputFields: schemaFields(contract.outputSchema).slice(0, 40),
    declaredRisk: contract.constraints.risk ?? null,
    toolkitVersion: contract.constraints.toolkitVersion ?? null,
    connected: contract.constraints.connected ?? null,
  }));
}

export type CompactToolContractView = ReturnType<typeof compactPlannerContracts>[number];

export function contractsForPlannerCorrection(input: {
  previousIR: LoopPlanningIR;
  internalContracts: ToolContract[];
  connectorContracts: ToolContract[];
}): ToolContract[] {
  const referencedConnectorRefs = new Set(input.previousIR.selectedActions.map((action) => action.contractRef.toLowerCase()));
  return [
    ...input.internalContracts,
    ...input.connectorContracts.filter((contract) => referencedConnectorRefs.has(contract.toolRef.toLowerCase())),
  ];
}

async function generateToolSearchPlan(input: {
  prompt: string;
  intentContext?: NoSlopSpecSnapshot["intentContext"];
  previousQueries?: string[];
  chat: typeof loopBuilderOpenAiChat;
}) {
  const response = await input.chat({
    responseFormat: {
      type: "json_schema",
      name: "tool_search_plan",
      schema: toolSearchPlanJsonSchema,
    },
    temperature: 0,
    maxTokens: 800,
    exactMaxTokens: true,
    retryEmptyResponses: false,
    reasoningEffort: "minimal",
    messages: [
      {
        role: "system",
        content: [
          "Identify whether exact external connector actions may be needed for this workflow.",
          "Return only the bounded connector catalogue search queries.",
          "Each query must be a concise 2-5 word capability search for a connector tool catalogue, not an action slug.",
          "When the request names an app or provider, include that exact app or provider name in the relevant query.",
          "Use separate queries for materially different connector capabilities.",
          input.previousQueries?.length
            ? "The previous queries returned no exact contracts. Reformulate them into shorter provider-and-capability searches."
            : "",
          "Return no queries when internal reasoning/search tools are sufficient.",
          "Do not choose actions yet.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          request: input.prompt,
          resolvedIntent: input.intentContext?.resolvedIntent ?? null,
          previousQueriesWithNoResults: input.previousQueries ?? [],
        }),
      },
    ],
  });
  return { plan: toolSearchPlanSchema.parse(parseObject(response.text)), model: response.model };
}

function buildPlannerPrompt(input: {
  prompt: string;
  noSlopSpec?: NoSlopSpecSnapshot;
  profile: string;
  memories: string;
  preferences: string[];
  internalContracts: ToolContract[];
  connectorContracts: ToolContract[];
  priorPlanningIR?: LoopPlanningIR;
}): string {
  return JSON.stringify({
    request: input.prompt,
    reviewedSpec: input.noSlopSpec?.specJson ?? null,
    resolvedIntent: input.noSlopSpec?.intentContext ?? null,
    profile: input.profile,
    recalledContext: input.memories,
    preferences: input.preferences,
    internalTools: compactPlannerContracts(input.internalContracts),
    discoveredConnectorActions: compactPlannerContracts(input.connectorContracts),
    priorPlanningIR: input.priorPlanningIR ?? null,
    planningSemantics: {
      resolvedRequiredValue: "The lifecycle and source are known. A runtime_input is resolved even though its actual value will only be supplied during a run.",
      unresolvedRequiredValue: "The planner cannot identify a safe lifecycle or source. This blocks approval.",
      derivable: "Content a semantic or connector node may generate, summarize, transform, or calculate.",
      passthrough: "Opaque non-generative data that must retain an externally supplied identity, such as recipients, IDs, file handles, or credentials.",
      connectorConnection: "Connector authorization is platform-managed runtime state. Never declare authorization, OAuth, access tokens, or connection state as requiredValues or action bindings.",
      connectorAvailability: "A disconnected selected connector is still a valid plan. Runtime opens a connection checkpoint before executing it.",
      runtimeInput: "Declare the runtime source and lifecycle as resolved; do not require the actual runtime value during planning.",
      finalSemanticOutput: "A final operator-visible semantic artifact may be terminal. Any other semantic output must have an explicit consumer.",
      internalToolUse: "Use an available exact internal tool directly when it performs the requested work. Do not require operator-provided substitutes for an available internal tool.",
    },
    platformInputSurfaces: [
      "input.text",
      "input.markdown",
      "input.contacts_csv",
      "input.audience_id",
      "input.file",
      "review.draft",
      "review.email",
      "review.preview",
      "review.sources",
      "review.memories",
      "confirm.send",
    ],
  });
}

function buildPlannerCorrectionPrompt(input: {
  previousIR: LoopPlanningIR | Record<string, unknown>;
  compilationIssues: PlanningCompilationIssue[];
  contracts: ToolContract[];
}): string {
  return JSON.stringify({
    previousPlanningIR: input.previousIR,
    compilationIssues: input.compilationIssues,
    referencedContracts: compactPlannerContracts(input.contracts),
  });
}

function planningSystemPrompt(): string {
  return [
    "You are the semantic workflow planner. Return only a compact LoopPlanningIR v2 JSON object.",
    "You own semantic decisions. Deterministic code will only validate and materialize exactly what you declare.",
    "Use version v2. Design only meaningful semantic agents. Never create coordinators, formatters, input collectors, checkpoints, or connector-action agents inside semanticAgents.",
    "Select connector actions only from discoveredConnectorActions and place them in selectedActions.",
    "When discoveredConnectorActions is empty, do not invent a connector tool ref, runtime connector action, or delivery semantic agent.",
    "A missing connector contract may be declared as an unresolved action issue, but semanticAgents must still use only exact internalTools.",
    "Do not require an external research connector when an available internal search tool satisfies the research work.",
    "Select actions by exact contractRef. For every selected action, inspect the compact field contract and declare every required field source with an explicit binding.",
    "Never invent recipients, IDs, files, credentials, account values, or other passthrough values.",
    "Declare such values in requiredValues with an explicit lifecycle and bind them through required_value.",
    "Passthrough means opaque externally supplied identity data only. Generated research, stories, summaries, drafts, bodies, subjects, and other semantic content are derivable, not passthrough.",
    "A runtime_input with a known operator_input source MUST use status resolved even though the operator has not supplied its actual value yet. Never use status unresolved for a declared runtime_input.",
    "Never model connector authorization, OAuth, credentials, access tokens, or connection state as a required value or action binding. The runtime handles connector connection checkpoints.",
    "Disconnected connector actions may be selected and compiled normally.",
    "Use available internal tools for their declared capabilities. Do not require operator content when an available internal tool can produce the source data.",
    "For each bound action field, provide an explicit semantic annotation based on the contract.",
    "Match selectedActions.annotation.effect to each contract declaredRisk. Use read_external only when declaredRisk is read.",
    "Unknown or low-confidence action risk must require approval.",
    "Semantic agents must have one meaningful responsibility and each output must have a declared downstream consumer.",
    "Use inputBindings to declare semantic agent dependencies. Do not rely on names or prose to imply handoffs.",
    "Declare compact output artifacts with named JSON-pointer fields and primitive JSON types. Never author JSON Schema.",
    "Text artifacts declare no fields and expose the implicit /text field. Use a json artifact when downstream steps need named structured fields.",
    "Use unresolvedIssues rather than guessing when a decision, action, value source, or binding cannot be established.",
    "A runtime input may remain without an actual value, but its lifecycle and source decision must be resolved.",
    "For an approved reviewed spec, resolve safe operational omissions as explicit visible model decisions. Do not silently default them.",
    "Do not emit implementation-detail clarification questions here; intent clarification happens before planning.",
  ].join(" ");
}

function correctionSystemPrompt(): string {
  return [
    "Return only the complete corrected compact LoopPlanningIR v2 JSON object.",
    "Fix every supplied compiler issue without changing unrelated semantic decisions.",
    "Use only the supplied referenced contracts.",
    "Every semanticAgents toolRef must exactly match a supplied internal contract.",
    "Every selected action contractRef must exactly match a supplied connector contract.",
    "Never represent a connector action, missing connector, delivery coordinator, or runtime-provided tool as a semantic agent.",
    "If a connector contract is unavailable, remove every semantic agent that pretends to perform that connector action and retain only genuine semantic work.",
    "Every non-terminal semantic agent output must bind to a downstream consumer. Mark the final operator-visible draft as visibility operator, or wire its artifact fields into a selected action.",
    "Runtime inputs with lifecycle runtime_input and sourceKind operator_input must use status resolved.",
    "Match action annotation effect to contract declaredRisk. Integer action fields require integer artifact fields or stable_config scalars.",
    "Remove bindings whose target paths are absent from the receiving agent input contract, or explicitly shape that input contract when the binding is semantically required.",
    "Do not invent sources, actions, bindings, identifiers, recipients, files, or credentials.",
  ].join(" ");
}

async function callPlanner(input: {
  prompt: string;
  noSlopSpec?: NoSlopSpecSnapshot;
  profile: string;
  memories: string;
  preferences: string[];
  internalContracts: ToolContract[];
  connectorContracts: ToolContract[];
  previousIR?: LoopPlanningIR;
  priorPlanningIR?: LoopPlanningIR;
  compilationIssues?: PlanningCompilationIssue[];
  chat: typeof loopBuilderOpenAiChat;
  timeoutMs: number;
  maxCompletionTokens: number;
  emptyResponseRetryMaxTokens: number;
  maxPromptBytes: number;
}): Promise<{
  planningIR: LoopPlanningIR;
  model: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  promptBytes: number;
  promptBreakdown: Record<string, number>;
  estimatedCostUsd: number;
}> {
  const startedAt = Date.now();
  const correction = Boolean(input.previousIR && input.compilationIssues?.length);
  const referencedContracts = input.previousIR
    ? contractsForPlannerCorrection({
        previousIR: input.previousIR,
        internalContracts: input.internalContracts,
        connectorContracts: input.connectorContracts,
      })
    : [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const plannerUserPrompt = correction
    ? buildPlannerCorrectionPrompt({
        previousIR: input.previousIR!,
        compilationIssues: input.compilationIssues!,
        contracts: referencedContracts,
      })
    : buildPlannerPrompt(input);
  const promptBreakdown = Object.fromEntries(Object.entries(parseObject(plannerUserPrompt))
    .map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))]));
  const promptBytes = Buffer.byteLength(plannerUserPrompt);
  if (promptBytes > input.maxPromptBytes) {
    throw new Error(`Planner prompt exceeded the ${input.maxPromptBytes}-byte input budget (${promptBytes} bytes).`);
  }
  let response: Awaited<ReturnType<typeof input.chat>>;
  const scopedPlanningSchema = loopPlanningIRJsonSchemaForContracts({
    internalToolRefs: input.internalContracts.map((contract) => contract.toolRef),
    connectorContractRefs: input.connectorContracts.map((contract) => contract.toolRef),
  });
  try {
    response = await input.chat({
      responseFormat: {
        type: "json_schema",
        name: "loop_planning_ir",
        schema: scopedPlanningSchema,
      },
      temperature: 0.1,
      maxTokens: input.maxCompletionTokens,
      exactMaxTokens: true,
      retryEmptyResponses: true,
      emptyResponseRetryMaxTokens: input.emptyResponseRetryMaxTokens,
      reasoningEffort: "minimal",
      signal: controller.signal,
      messages: correction
        ? [
            { role: "system", content: correctionSystemPrompt() },
            {
              role: "user",
              content: plannerUserPrompt,
            },
          ]
        : [
            { role: "system", content: planningSystemPrompt() },
            { role: "user", content: plannerUserPrompt },
          ],
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Planner request exceeded the ${input.timeoutMs}ms attempt timeout.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let proposal: Record<string, unknown>;
  try {
    proposal = parseObject(response.text);
  } catch (error) {
    throw new InvalidPlanningIRProposalError(error instanceof Error ? error.message : String(error));
  }
  const candidate = proposal.planningIR && typeof proposal.planningIR === "object" && !Array.isArray(proposal.planningIR)
    ? proposal.planningIR
    : proposal;
  const parsed = loopPlanningIRSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = formatPlanningValidationIssues(parsed.error);
    throw new InvalidPlanningIRProposalError(
      issues.map((issue) => issue.message).join("; "),
      proposal,
      issues,
    );
  }
  const promptTokens = response.usage.promptTokens ?? 0;
  const completionTokens = response.usage.completionTokens ?? 0;
  return {
    planningIR: parsed.data,
    model: response.model,
    durationMs: Date.now() - startedAt,
    promptTokens,
    completionTokens,
    promptBytes,
    promptBreakdown,
    estimatedCostUsd: estimateLoopBuilderCostUsd(response.model, promptTokens, completionTokens),
  };
}

function compatibleDesign(ir: LoopPlanningIR, graph: ReturnType<typeof loopAgentGraphSchema.parse>): LoopArchitectOutput {
  const writeAction = ir.selectedActions.find((action) =>
    action.annotation.approvalRequired || action.annotation.effect !== "read_external");
  return {
    title: ir.title,
    summary: ir.summary,
    strategyText: ir.strategy,
    inputsRequired: ir.requiredValues.filter((value) => value.lifecycle === "runtime_input").map((value) => value.key),
    inputRequirements: [],
    delivery: { provider: writeAction?.contractRef ?? "none" },
    schedule: ir.schedule,
    agents: graph.children.map((node) => ({
      nodeKind: node.nodeKind,
      id: node.id,
      name: node.name,
      goal: node.goal ?? node.task,
      task: node.task,
      tool: node.tools[0]?.ref ?? "internal.llm_only",
      ...(node.tools[0]?.config ? { toolConfig: node.tools[0].config } : {}),
      inputContract: node.inputContract ?? { description: "Declared input", schema: {} },
      outputContract: node.outputContract ?? {
        description: "Declared output",
        schema: {},
        representation: "text",
        mediaType: "text/plain",
        visibility: "internal",
      },
      handoffBindings: node.handoffBindings,
      doneCriteria: node.doneCriteria ?? ["Declared goal is complete"],
      ...(node.gate ? { gate: node.gate } : {}),
    })),
    rationale: [ir.strategy],
    suggestedChannels: ["primary"],
  };
}

export async function designLoopFromIntent(input: DesignLoopInput): Promise<{
  design: LoopArchitectOutput & { agentGraph: ReturnType<typeof loopAgentGraphSchema.parse> };
  definition: LoopDefinition;
  memories: Array<{ id: string; text: string; score: number }>;
  preferences: Array<{ id: string; text: string; category?: string | null }>;
  model: string;
  suggestedToolRefs: string[];
  suggestedChannels: LoopStageApprovalChannel[];
  trace: LoopBuilderTrace;
  critic: WorkflowCriticResult;
}> {
  const prompt = input.prompt.trim().replace(/\s+/g, " ");
  if (!prompt) throw new Error("Prompt is required");
  const chat = input.testOverrides?.chat ?? loopBuilderOpenAiChat;
  const recall = input.testOverrides?.recallForDesigner ?? recallForDesigner;
  const listPrefs = input.testOverrides?.listPreferences ?? listPreferences;

  const [profile, preferences, baseRegistry] = await Promise.all([
    loadWorkflowUserProfile(input.auth).catch(() => null),
    listPrefs(input.auth).catch(() => []),
    buildToolSpecRegistry(input.auth, { includeConnectedToolkits: false }),
  ]);
  const memories = await recall(prompt, input.auth, { profile }).catch(() => []);
  const selectedPreferences = preferences.slice(0, 8).map((item) => ({
    id: item.id,
    text: item.text,
    category: item.category ?? null,
  }));
  const search = await generateToolSearchPlan({
    prompt,
    intentContext: input.noSlopSpec?.intentContext,
    chat,
  });
  const specPolicyActions = input.noSlopSpec
    ? [...input.noSlopSpec.specJson.connectorPolicy.allowedReadActions, ...input.noSlopSpec.specJson.connectorPolicy.allowedWriteActions]
    : [];
  const inferredActions = inferRequiredConnectorActions({
    prompt,
    deliveryProvider: input.noSlopSpec?.specJson.delivery.provider,
    deliveryDescription: input.noSlopSpec?.specJson.delivery.description,
    intentText: input.noSlopSpec?.intentContext?.resolvedIntent,
  });
  const requiredActions = [...specPolicyActions, ...inferredActions];
  let discoveryQueries = discoveryQueriesForRequiredActions(
    [...new Set(search.plan.queries.map((query) => query.trim()).filter(Boolean))],
    inferredActions,
  );
  reportLoopBuilderProgress({
    stage: "tool_discovery",
    message: `Searching connector catalogue with ${discoveryQueries.length} bounded ${discoveryQueries.length === 1 ? "query" : "queries"}`,
    status: "running",
    details: {
      modelQueries: search.plan.queries,
      effectiveQueries: discoveryQueries,
      requiredActions,
    },
  });
  let discoveredBySearch = await discoverToolsForQueries(input.auth, discoveryQueries, 12);
  if (discoveredBySearch.length === 0 && discoveryQueries.length > 0) {
    reportLoopBuilderProgress({
      stage: "tool_discovery",
      message: "No exact connector contracts found; reformulating catalogue queries once",
      status: "running",
      details: { queriesWithNoResults: discoveryQueries },
    });
    const retrySearch = await generateToolSearchPlan({
      prompt,
      intentContext: input.noSlopSpec?.intentContext,
      previousQueries: discoveryQueries,
      chat,
    });
    discoveryQueries = [...new Set(retrySearch.plan.queries.map((query) => query.trim()).filter(Boolean))].slice(0, 4);
    discoveredBySearch = await discoverToolsForQueries(input.auth, discoveryQueries, 12);
  }
  const discovered = await mergeRequiredToolContracts(
    discoveredBySearch,
    requiredActions,
  );
  const connectorContracts = discovered.map((entry) => ({
    ...entry.contract,
    constraints: { ...entry.contract.constraints, connected: entry.connected },
  }));
  const internalContracts = baseRegistry.toolContracts.filter((contract) => contract.provider === "internal");
  reportLoopBuilderProgress({
    stage: "tool_discovery",
    message: `Loaded ${connectorContracts.length} connector contracts and ${internalContracts.length} internal contracts`,
    status: "completed",
    details: {
      connectorContracts: discovered.map((entry) => ({
        toolRef: entry.contract.toolRef,
        name: entry.contract.name,
        source: entry.source,
        connected: entry.connected,
        risk: entry.contract.constraints.risk ?? null,
        toolkitVersion: entry.contract.constraints.toolkitVersion ?? null,
        requiredInputPaths: Array.isArray(entry.contract.inputSchema.required) ? entry.contract.inputSchema.required : [],
      })),
      effectiveQueries: discoveryQueries,
      internalContracts: internalContracts.map((contract) => ({ toolRef: contract.toolRef, name: contract.name })),
    },
  });

  let planningIR: LoopPlanningIR | undefined;
  let compiled: ReturnType<typeof compileLoopPlanningIR> | undefined;
  let model = loopBuilderOpenAiModel();
  const plannerStages: Array<z.infer<typeof loopBuilderTraceStageSchema>> = [];
  let compilationIssues: PlanningCompilationIssue[] | undefined;
  let bestCompilationIssues: PlanningCompilationIssue[] | undefined;
  let lastAttemptFailedBeforePlanning = false;
  const plannerConfig = planningProgressConfig();
  const maxPlanningAttempts = 1 + plannerConfig.maxCorrectionAttempts;
  const priorPlanningIRResult = loopPlanningIRSchema.safeParse(input.priorProposal?.definition.builderMeta?.planningIR);
  const priorPlanningIR = priorPlanningIRResult.success ? priorPlanningIRResult.data : undefined;

  let transportFailures = 0;
  for (let attempt = 0; attempt < maxPlanningAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    const kind = planningIR ? "correction" as const : "initial" as const;
    const issuesBefore = compilationIssues ?? [];
    reportLoopBuilderProgress({
      stage: "planning",
      message: kind === "initial"
        ? "Creating initial executable plan"
        : `Correcting ${issuesBefore.length} contract ${issuesBefore.length === 1 ? "issue" : "issues"}`,
      status: "running",
      details: {
        attempt: attempt + 1,
        kind,
        maxAttempts: maxPlanningAttempts,
        timeoutMs: plannerConfig.attemptTimeoutMs,
        maxCompletionTokens: plannerConfig.maxCompletionTokens,
        emptyResponseRetryMaxTokens: plannerConfig.emptyResponseRetryMaxTokens,
        maxPromptBytes: plannerConfig.maxPromptBytes,
        strictSchemaBytes: Buffer.byteLength(JSON.stringify(loopPlanningIRJsonSchemaForContracts({
          internalToolRefs: internalContracts.map((contract) => contract.toolRef),
          connectorContractRefs: connectorContracts.map((contract) => contract.toolRef),
        }))),
        previousPlan: planningIR ? {
          title: planningIR.title,
          semanticAgents: planningIR.semanticAgents.map((agent) => ({ id: agent.id, responsibility: agent.responsibility, toolRef: agent.toolRef })),
          selectedActions: planningIR.selectedActions.map((action) => ({ id: action.id, contractRef: action.contractRef, bindingCount: action.bindings.length })),
          unresolvedIssues: planningIR.unresolvedIssues,
        } : null,
        issuesToFix: compilationIssues ?? [],
      },
    });
    let result: Awaited<ReturnType<typeof callPlanner>>;
    try {
      result = await callPlanner({
        prompt,
        noSlopSpec: input.noSlopSpec,
        profile: profile ? formatWorkflowUserProfile(profile) : "",
        memories: formatMemoriesForArchitect(memories.filter((memory) => !memory.metadata?.profile)),
        preferences: selectedPreferences.map((item) => item.text),
        internalContracts,
        connectorContracts,
        previousIR: kind === "correction" ? planningIR : undefined,
        priorPlanningIR: kind === "initial" ? priorPlanningIR : undefined,
        compilationIssues,
        chat,
        timeoutMs: plannerConfig.attemptTimeoutMs,
        maxCompletionTokens: plannerConfig.maxCompletionTokens,
        emptyResponseRetryMaxTokens: plannerConfig.emptyResponseRetryMaxTokens,
        maxPromptBytes: plannerConfig.maxPromptBytes,
      });
    } catch (error) {
      const structuralFailure = error instanceof InvalidPlanningIRProposalError;
      const canRetryTransport = shouldRetryPlanningTransportFailure({
        structuralFailure,
        attempt,
        maxPlanningAttempts,
        transportFailures,
      });
      if (canRetryTransport) transportFailures += 1;
      lastAttemptFailedBeforePlanning = !structuralFailure;
      const failureReason = structuralFailure ? "structural_failure" as const : "attempt_failed" as const;
      compilationIssues = error instanceof InvalidPlanningIRProposalError && error.issues.length > 0
        ? error.issues
        : [{
            code: "planner_request_failed",
            message: error instanceof Error ? error.message : String(error),
          }];
      reportLoopBuilderProgress({
        stage: "planning_validation",
        message: structuralFailure
          ? "Stopped: planner returned structurally invalid output"
          : canRetryTransport
            ? "Planner request failed before producing a plan; retrying once"
            : "Stopped: planner request failed before producing a valid plan",
        status: canRetryTransport ? "running" : "failed",
        details: {
          issues: compilationIssues,
          proposal: error instanceof InvalidPlanningIRProposalError ? error.proposal : undefined,
          stopReason: canRetryTransport ? null : failureReason,
          retriesRemaining: canRetryTransport ? 1 : 0,
          durationMs: Date.now() - attemptStartedAt,
        },
      });
      plannerStages.push(loopBuilderTraceStageSchema.parse({
        stage: "model_planner",
        model,
        input: { attempt, searchQueries: search.plan.queries },
        output: { compilationIssues, stopReason: canRetryTransport ? null : failureReason },
      }));
      if (canRetryTransport) continue;
      break;
    }
    lastAttemptFailedBeforePlanning = false;
    planningIR = result.planningIR;
    model = result.model;
    planningIR.schedule = {
      cron: planningIR.schedule.cron.trim(),
      timezone: planningIR.schedule.timezone.trim(),
    };
    compiled = compileLoopPlanningIR({ planningIR, contracts: [...internalContracts, ...connectorContracts] });
    const issuesAfter = compiled.ok ? [] : compiled.issues;
    const issueComparison = comparePlanningIssues(issuesBefore, issuesAfter);
    const stopReason = planningAttemptStopReason({
      previousIssues: issuesBefore,
      currentIssues: issuesAfter,
      correction: kind === "correction",
      lastAttempt: attempt === maxPlanningAttempts - 1,
    });
    const attemptResult: PlanningAttemptResult = {
      attempt: attempt + 1,
      kind,
      durationMs: result.durationMs,
      issueFingerprint: planningIssueFingerprint(issuesAfter),
      issueCountBefore: issuesBefore.length,
      issueCountAfter: issuesAfter.length,
      ...issueComparison,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      promptBytes: result.promptBytes,
      promptBreakdown: result.promptBreakdown,
      estimatedCostUsd: result.estimatedCostUsd,
      ...(stopReason ? { stopReason } : {}),
    };
    if (compiled.ok || !bestCompilationIssues || issuesAfter.length < bestCompilationIssues.length) {
      bestCompilationIssues = issuesAfter;
    }
    reportLoopBuilderProgress({
      stage: "planning_result",
      message: `Planner proposed ${planningIR.semanticAgents.length} semantic agents and ${planningIR.selectedActions.length} connector actions`,
      status: compiled.ok ? "completed" : "running",
      details: {
        title: planningIR.title,
        strategy: planningIR.strategy,
        schedule: planningIR.schedule,
        requiredValues: planningIR.requiredValues.map((value) => ({
          key: value.key,
          lifecycle: value.lifecycle,
          timing: value.timing,
          status: value.status,
          sourceKind: value.sourceKind,
        })),
        semanticAgents: planningIR.semanticAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          responsibility: agent.responsibility,
          toolRef: agent.toolRef,
          inputBindings: agent.inputBindings,
          outputArtifact: agent.outputArtifact,
        })),
        selectedActions: planningIR.selectedActions.map((action) => ({
          id: action.id,
          contractRef: action.contractRef,
          annotation: action.annotation,
          bindings: action.bindings,
        })),
        unresolvedIssues: planningIR.unresolvedIssues,
        attemptResult,
      },
    });
    plannerStages.push(loopBuilderTraceStageSchema.parse({
      stage: "model_planner",
      model,
      input: { attempt, searchQueries: search.plan.queries, compilationIssues: compilationIssues ?? [] },
      output: { planningIR, compilation: compiled, attemptResult },
    }));
    if (compiled.ok) break;
    compilationIssues = compiled.issues;
    reportLoopBuilderProgress({
      stage: "contract_validation",
      message: stopReason === "repeated_issues"
        ? `Stopped: planner repeated the same ${compiled.issues.length} ${compiled.issues.length === 1 ? "issue" : "issues"}`
        : stopReason === "worsened"
          ? `Stopped: correction introduced more issues without resolving existing issues`
          : stopReason === "correction_limit"
            ? `Stopped: planner reached the ${plannerConfig.maxCorrectionAttempts}-correction limit`
            : `Contract validation found ${compiled.issues.length} ${compiled.issues.length === 1 ? "issue" : "issues"}; preparing targeted correction`,
      status: stopReason ? "failed" : "running",
      details: { issues: compiled.issues, attemptResult, stopReason: stopReason ?? null },
    });
    if (stopReason) break;
  }
  if (!planningIR || !compiled?.ok) {
    const issues = bestCompilationIssues?.length
      ? bestCompilationIssues.map((issue) => issue.message).join("; ")
      : compilationIssues?.map((issue) => issue.message).join("; ") || "Planner returned no valid IR.";
    if (!planningIR && lastAttemptFailedBeforePlanning) {
      throw new Error(`Loop planner request failed: ${issues}`);
    }
    throw new Error(`Loop planning IR failed structural compilation: ${issues}`);
  }

  const graph = compiled.compiled.graph;
  reportLoopBuilderProgress({
    stage: "contract_validation",
    message: `Compiled ${compiled.compiled.graph.children.length} executable nodes with explicit bindings`,
    status: "completed",
    details: {
      graph: compiled.compiled.graph.children.map((node) => ({
        id: node.id,
        name: node.name,
        nodeKind: node.nodeKind,
        tools: node.tools,
        handoffBindings: node.handoffBindings,
        gate: node.gate ?? null,
      })),
      inputRequirements: compiled.compiled.inputRequirements,
      connectorPolicy: compiled.compiled.connectorPolicy,
    },
  });
  const design = compatibleDesign(planningIR, graph);
  design.inputRequirements = compiled.compiled.inputRequirements;
  const delivery = design.delivery;
  const selectedAnnotations = new Map(planningIR.selectedActions.map((action) => [
    action.contractRef.toLowerCase(),
    action.annotation,
  ]));
  const plannedConnectorContracts = connectorContracts.map((contract) => {
    const annotation = selectedAnnotations.get(contract.toolRef.toLowerCase());
    if (!annotation) return contract;
    return {
      ...contract,
      semanticAnnotation: annotation as unknown as Record<string, unknown>,
      readiness: {
        ...(contract.readiness ?? {
          toolRef: contract.toolRef,
          originalInputSchema: contract.inputSchema,
          effectiveInputSchema: contract.inputSchema,
          semanticAssertions: [],
          fieldPolicies: {},
          unresolvedRequirements: [],
          sourceHash: "",
          generatedBy: "sdk_contract" as const,
          generatedAt: new Date().toISOString(),
        }),
        generatedBy: "model_annotation" as const,
      },
    };
  });
  const definition = buildLoopDefinitionFromCeoDesign({
    goal: prompt,
    design: {
      agentGraph: graph,
      schedule: planningIR.schedule,
      deliveryType: delivery.provider === "none" ? undefined : "external_action",
      builderMeta: {
        designedBy: "loop_architect",
        engineVersion: LOOP_ENGINE_VERSION,
        model,
        preApproved: true,
        ...(input.noSlopSpec ? { noSlopSpec: input.noSlopSpec } : {}),
        agentSpecGeneration: { mode: "hybrid", model, generatedAt: new Date().toISOString() },
        designDiagnostics: {
          planningIR,
          searchPlan: search.plan,
          ...(input.noSlopSpec?.intentContext ? { intentContext: input.noSlopSpec.intentContext } : {}),
        },
        planningIRVersion: "v2",
        planningIR: planningIR as unknown as Record<string, unknown>,
        discoveredToolContracts: plannedConnectorContracts as unknown as Array<Record<string, unknown>>,
        typedConnectorHandoffs: "v2",
        contractDrivenGraph: "v1",
        ...(profile ? { workflowUserProfile: profile } : {}),
      },
    },
    delivery,
    connectorPolicy: compiled.compiled.connectorPolicy,
    inputsRequired: compiled.compiled.inputRequirements.map((requirement) => requirement.key),
    inputRequirements: compiled.compiled.inputRequirements,
    engineVersion: LOOP_ENGINE_VERSION,
  });

  const rosterValidation = await validateAgentRoster({
    agents: graph.children.map((child) => ({
      id: child.id,
      name: child.name,
      task: child.task,
      goal: child.goal,
      tools: child.tools,
      doneCriteria: child.doneCriteria,
      gate: child.gate,
      outputArtifactId: child.outputArtifactId,
    })),
    definition: getEffectiveLoopConstraints(definition),
    auth: input.auth,
    strictConnectors: false,
  });
  if (!rosterValidation.ok) {
    throw new Error(`Compiled planning IR produced invalid roster: ${(rosterValidation.issues ?? []).map((issue) => issue.message).join("; ")}`);
  }

  const suggestedChannels = ["primary"].flatMap((channel) => {
    const parsed = loopStageApprovalChannelInputSchema.safeParse(channel);
    return parsed.success ? [parsed.data] : [];
  });
  const trace = loopBuilderTraceSchema.parse({
    stages: [
      loopBuilderTraceStageSchema.parse({
        stage: "tool_search_plan",
        model: search.model,
        input: { prompt },
        output: search.plan,
      }),
      ...plannerStages,
    ],
  });
  const critic: WorkflowCriticResult = {
    pass: true,
    riskLevel: compiled.compiled.connectorPolicy.allowedWriteActions.length > 0 ? "medium" : "low",
    issues: [],
    requiredFixes: [],
  };
  return {
    design: { ...design, agentGraph: graph },
    definition,
    memories: memories.map((memory) => ({ id: memory.id, text: memory.text, score: memory.score })),
    preferences: selectedPreferences,
    model,
    suggestedToolRefs: [...new Set(graph.children.flatMap((child) => child.tools.map((tool) => tool.ref)))],
    suggestedChannels,
    trace,
    critic,
  };
}

export function channelsFromDesign(channels: LoopStageApprovalChannel[]): LoopStageApprovalChannel[] {
  return channels.length > 0 ? channels : ["primary"];
}
