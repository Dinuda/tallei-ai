/**
 * Model-owned planning with contract-only deterministic compilation.
 */

import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { listPreferences } from "../memory.js";
import { buildLoopDefinitionFromCeoDesign } from "../loop-executor/creator.js";
import { normalizeDesignCron } from "../loop-executor/cron.js";
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
  deriveRequiredConnectorActionsFromSpec,
  normalizeProviderIdentity,
  specSemanticPipeline,
} from "./spec-required-connectors.js";
import {
  compileLoopPlanningIR,
  loopPlanningIRJsonSchemaForContracts,
  loopPlanningIRSchema,
  schemaAddressablePaths,
  seedRequiredValuesFromSpec,
  type LoopPlanningIR,
  type PlanningCompilationIssue,
} from "./planning-ir.js";
import { formatMemoriesForArchitect, recallForDesigner } from "./recall.js";
import { formatWorkflowUserProfile, loadWorkflowUserProfile } from "./workflow-user-profile.js";
import {
  buildToolSpecRegistry,
} from "../tool-spec/index.js";
import { planningHintsForContract } from "../tool-spec/contract-planning-guidance.js";
import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
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
  discoveredToolContracts?: ToolContract[];
};

const MAX_PLANNING_CORRECTIONS = 3;
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
    maxCorrectionAttempts: MAX_PLANNING_CORRECTIONS,
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
  return contracts.map((contract) => {
    const planningHints = planningHintsForContract(contract);
    return {
      contractRef: contract.toolRef,
      name: contract.name,
      description: contract.description,
      provider: contract.provider,
      inputFields: schemaFields(contract.inputSchema).slice(0, 40),
      outputFields: schemaFields(contract.outputSchema).slice(0, 40),
      outputPaths: schemaAddressablePaths(contract.outputSchema).slice(0, 24),
      declaredRisk: contract.constraints.risk ?? null,
      toolkitVersion: contract.constraints.toolkitVersion ?? null,
      connected: contract.constraints.connected ?? null,
      ...(planningHints.length > 0 ? { planningHints } : {}),
    };
  });
}

export type CompactToolContractView = ReturnType<typeof compactPlannerContracts>[number];

export function contractsForPlannerCorrection(input: {
  previousIR: LoopPlanningIR;
  internalContracts: ToolContract[];
  connectorContracts: ToolContract[];
}): ToolContract[] {
  return [...input.internalContracts, ...input.connectorContracts];
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
  const specInputCandidates = input.noSlopSpec
    ? seedRequiredValuesFromSpec(input.noSlopSpec.specJson.inputRequirements ?? [])
    : [];
  return JSON.stringify({
    request: input.prompt,
    reviewedSpec: input.noSlopSpec?.specJson ?? null,
    resolvedIntent: input.noSlopSpec?.intentContext ?? null,
    specInputCandidates,
    specSemanticPipeline: input.noSlopSpec ? specSemanticPipeline(input.noSlopSpec.specJson) : [],
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
    platformRenderers: [
      { rendererRef: "canvas.email", accepts: ["text", "json"], purpose: "Editable email artifact review." },
      { rendererRef: "canvas.preview", accepts: ["text", "json"], purpose: "Read-only final artifact preview." },
    ],
  });
}

export function buildPlannerCorrectionPrompt(input: {
  previousIR: LoopPlanningIR | Record<string, unknown>;
  compilationIssues: PlanningCompilationIssue[];
  contracts: ToolContract[];
}): string {
  const previousIR = loopPlanningIRSchema.safeParse(input.previousIR);
  const declaredRequiredValueKeys = previousIR.success
    ? previousIR.data.requiredValues.map((value) => value.key)
    : [];
  const declaredRequiredValueKeySet = new Set(declaredRequiredValueKeys);
  const danglingRequiredValueBindings = previousIR.success
    ? [
        ...previousIR.data.semanticAgents.flatMap((agent) => agent.inputBindings.map((binding) => ({
          owner: agent.id,
          binding,
        }))),
        ...previousIR.data.selectedActions.flatMap((action) => action.bindings.map((binding) => ({
          owner: action.id,
          binding,
        }))),
      ].flatMap(({ owner, binding }) =>
        binding.source.kind === "required_value" && !declaredRequiredValueKeySet.has(binding.source.key)
          ? [{
              owner,
              targetPath: binding.targetPath,
              missingRequiredValueKey: binding.source.key,
            }]
          : [])
    : [];
  return JSON.stringify({
    previousPlanningIR: input.previousIR,
    compilationIssues: input.compilationIssues,
    bindingAudit: {
      declaredRequiredValueKeys,
      danglingRequiredValueBindings,
      requiredCorrection: "Remove each dangling binding unless it represents genuinely operator-supplied data; only then declare the missing required value with an exact lifecycle and runtime source.",
    },
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
    "Prefer internal.web_search for research; do not select an external search connector when an available internal search tool satisfies the research work.",
    "specInputCandidates are data-input candidates declared by the reviewed spec. Include a candidate in requiredValues only when it has an explicit semantic-agent or connector-action consumer in this plan.",
    "Omit any specInputCandidate that describes platform approval policy, approvers, review control flow, connector authorization, or data unused by the executable plan.",
    "Every requiredValues entry must have at least one explicit consumer. Never preserve an unused required value merely because it appeared in the reviewed spec.",
    "Every required_value binding must reference a key declared exactly once in requiredValues. Before returning, cross-check every required_value source.key against requiredValues; never emit a dangling required_value binding.",
    "Do not add connector account names, sender addresses, OAuth tokens, authorization state, approval state, or approver lists as additional required values.",
    "When a spec agent goal names multiple distinct connector actions (e.g., send email and create calendar invite), each must be a separate entry in selectedActions with its own contractRef and bindings.",
    "selectedActions is an executable action list, not a menu of alternatives. Never include mutually exclusive actions and ask runtime or the operator to select one.",
    "When multiple discovered actions could satisfy the same delivery behavior, select exactly one action supported by the reviewed spec and resolved intent. If the reviewed spec leaves the behavior open, make one explicit visible planning decision in strategy; do not emit both actions.",
    "When reviewedSpec.delivery.provider names a provider other than none and discoveredConnectorActions contains actions from that provider, selectedActions implementing delivery MUST use that provider. Do not substitute another provider.",
    "Never say the planner cannot autonomously choose between feasible actions. Action selection is the planner's responsibility.",
    "Never model connector delivery or scheduling as a semantic agent. Dispatch, send, and calendar actions belong only in selectedActions.",
    "Approval is platform control flow, never connector data. Express it only through selectedActions.annotation.approvalRequired. Never create requiredValues, bindings, or unresolvedIssues for approval confirmation, approver lists, approval enforcement, confirm.send, or approval tokens.",
    "The runtime guarantees that an action requiring approval cannot execute before its compiled confirm_action interaction is approved. Do not ask the plan, connector payload, or operator input to enforce that guarantee.",
    "Follow specSemanticPipeline order: each semantic agent except the final content agent must declare inputBindings from the upstream agent output or bind its output into the downstream agent or selectedActions.",
    "Do not create standalone context, briefing, or coordination semantic agents. Fold product context into research or analysis agents.",
    "Recipient and attendee lists from input.contacts_csv use valueType array and may bind to connector array fields such as /attendees or /to with required_value, valuePolicy passthrough, and provenance stable_config or operator_input. Never bind /attendees or /to from agent_output.",
    "input.contacts_csv collects ONLY valueType array. input.audience_id, input.text, input.file collect ONLY valueType string. A recipient group, contact list, or attendee list is valueType array and MUST use input.contacts_csv — never input.audience_id. A single audience/list identifier is valueType string and uses input.audience_id.",
    "When a send or calendar action needs concrete recipients/attendees but the intent only names a group, team, or audience, do NOT emit a blocking unresolvedIssue. Declare a recipient requiredValue (lifecycle workflow_config, surface input.contacts_csv, valueType array, sourceKind stable_config) and bind it to the action recipient field. The operator supplies the concrete addresses; the planner never needs to resolve a group name into addresses itself.",
    "Every required connector input the operator can supply (recipients, attendees, start/end datetime, event duration, location, subject lines, audience ids) MUST be satisfied by binding it to either an upstream agent_output field or a declared requiredValue. Never leave a required connector input unbound and never emit a blocking unresolvedIssue when the value is something an operator can provide as a workflow_config or runtime_input.",
    "A connector datetime field such as /start_datetime is a scheduling configuration value: declare it as a workflow_config requiredValue (valueType string, surface input.text, sourceKind stable_config) and bind it, unless an upstream agent computes it.",
    "workflow_config requiredValues must use sourceKind stable_config and bindings must use provenance stable_config. runtime_input requiredValues must use sourceKind operator_input and bindings must use provenance operator_input.",
    "Boolean connector fields such as /is_html require a boolean source. Use a workflow_config requiredValue with valueType boolean and stableScalar true or false, declare a boolean field on a json outputArtifact, or omit the optional binding entirely.",
    "Select actions by exact contractRef. For every selected action, inspect the compact field contract and declare every required field source with an explicit binding.",
    "Each contract in internalTools and discoveredConnectorActions may include planningHints. Follow those action-specific hints for binding, chaining, and field typing. Do not apply tool-specific rules that are absent from the loaded contract.",
    "Bind every required connector input. Bind an optional connector input only when the workflow genuinely needs it and an exact type-compatible source exists; otherwise omit that optional binding.",
    "Never invent recipients, IDs, files, credentials, account values, or other passthrough values.",
    "Declare such values in requiredValues with an explicit lifecycle and bind them through required_value.",
    "Passthrough means opaque externally supplied identity data only. Generated research, stories, summaries, drafts, bodies, subjects, and other semantic content are derivable, not passthrough.",
    "A runtime_input with a known operator_input source MUST use status resolved even though the operator has not supplied its actual value yet. Never use status unresolved for a declared runtime_input.",
    "Never model connector authorization, OAuth, SMTP credentials, API keys, access tokens, or connection state as a required value or action binding. The runtime handles connector connection checkpoints automatically via a dedicated connect_connector gate.",
    "Disconnected connector actions may be selected and compiled normally. Never add a requiredValue for authentication or account credentials.",
    "Use available internal tools for their declared capabilities. Do not require operator content when an available internal tool can produce the source data.",
    "Semantic tool instructions belong in semanticAgents.task. internal.llm_only receives its prompt from task and the loop goal; internal.web_search and internal.memory_search derive their query from task. Do not create /prompt or /query inputBindings merely to restate a semantic agent's task.",
    "For each bound action field, provide an explicit semantic annotation based on the contract.",
    "Match selectedActions.annotation.effect to each contract declaredRisk. Use read_external only when declaredRisk is read.",
    "Unknown or low-confidence action risk must require approval.",
    "Semantic agents must have one meaningful responsibility and each output must have a declared downstream consumer.",
    "Use inputBindings to declare semantic agent dependencies. Do not rely on names or prose to imply handoffs.",
    "In every binding, source.nodeId must exactly match a semanticAgent id (e.g. \"email_composer\"), never the artifact id inside that agent's outputArtifact (e.g. \"final_email_draft\"). Each agent has two distinct id fields: the agent's own id and its outputArtifact.id — only the agent's own id is valid as source.nodeId.",
    "Declare compact output artifacts with named JSON-pointer fields and primitive JSON types. Never author JSON Schema.",
    "Every output artifact must explicitly declare rendererRef, reviewMode, and editable.",
    "Use reviewMode required only when an operator must review that exact artifact. Use rendererRef null when no renderer is needed.",
    "An editable reviewed email artifact should use rendererRef canvas.email. A read-only reviewed preview should use canvas.preview.",
    "Text artifacts declare no fields and expose the implicit /text field. Use a json artifact when downstream steps need named structured fields.",
    "A text artifact MUST use fields: []. If downstream consumers need multiple named fields, use representation json and declare those exact fields.",
    "For every agent_output or connector_output binding, source.nodeId must be the exact producer node id and source.path must use slash-separated JSON pointer segments only. Never use dot notation such as /data.response_data.draft_id; use /data/response_data/draft_id only when that exact path appears in the producer outputPaths.",
    "For connector_output bindings, source.path must exactly match one path in the producer contract outputPaths or outputFields. Do not invent nested fields under opaque connector envelopes such as /data when only /data itself is declared.",
    "Before returning, audit every binding against the artifacts declared in the same response. If a consumer needs a missing derivable field, add that field to the responsible producer artifact; otherwise remove or resolve the binding.",
    "Use unresolvedIssues only for genuinely unresolvable planning decisions: a required connector contract is missing, no action in discoveredConnectorActions satisfies a delivery requirement, or a required data source identity cannot be determined. Set blocksApproval true only for these cases.",
    "Never emit a blocking unresolved issue for runtime operational edge cases. Zero-result research, empty data sets, blocked sources, or conditional email-vs-no-email behaviour are handled by the semantic agent at runtime, not by the planner. Set blocksApproval false or omit the issue entirely.",
    "Connector action nodes only expose output schema paths in their outputPaths. Never bind a downstream action from a connector node's /input sub-object; /input is not an output path. Bind derived content (subject, body, summaries) from the semantic agent outputArtifact fields.",
    "A runtime input may remain without an actual value, but its lifecycle and source decision must be resolved.",
    "For an approved reviewed spec, resolve safe operational omissions as explicit visible model decisions. Do not silently default them.",
    "Do not block an approved reviewed spec merely because several feasible implementation actions exist. Select the smallest action chain that directly implements the reviewed behavior.",
    "Schedule timezone and exact times are workflow configuration decisions, not runtime computation tasks. Use resolved intent or reviewed spec values; when the reviewed spec permits an assumption, record the assumption in strategy and provide a concrete schedule.",
    "schedule.cron and schedule.timezone are the only schedule fields. Never add timezone or cron as requiredValues entries; they are consumed by the compiled loop schedule, not by agent or action bindings.",
    "schedule.cron must be a standard 5-field cron with numeric day-of-week 0-6 (0=Sunday, 5=Friday). Never use day names such as FRI or Friday in cron fields.",
    "Classify requiredValues lifecycle explicitly. workflow_config: stable loop settings the operator answers once at build time — recipient lists, max story limits, permanent source priority/block lists, tool preferences, product briefs, competitor lists, content format/tone/length constraints, preferred cadence. Set stableScalar when the value is known from intent; otherwise set status resolved with stableScalar null so the build UI can collect it before save.",
    "runtime_input: per-run operator decisions that depend on what the agent produced in this specific run — which of the sources the agent just discovered should be included, which memories to keep after this run's memory search. Use timing before_step or before_send. This list must be very short and genuinely per-run.",
    "Apply this test: would the operator give the same answer regardless of what the agent produced this run? Use workflow_config. Does the answer require seeing this run's specific agent output first? Use runtime_input. Recipient lists, product briefs, competitor lists, and format constraints are always workflow_config.",
    "Never add connector account authorization, OAuth tokens, connection state, or approval state as runtime_input or workflow_config. The runtime handles connector connection checkpoints automatically.",
    "Use input.text for briefs, links, URLs, and pasted document content. Reserve input.file only when the operator must supply an uploaded file reference, not pasted prose.",
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
    "selectedActions is executable, not a runtime choice menu. Remove mutually exclusive alternative actions and keep exactly the action that implements the reviewed behavior.",
    "The planner owns action selection. Never retain an unresolved issue whose reason is that the planner cannot choose between feasible discovered actions.",
    "Every non-terminal semantic agent output must bind to a downstream consumer. Mark the final operator-visible draft as visibility operator, or wire its artifact fields into a selected action.",
    "Wire research and context agents into the next pipeline agent using agent_output inputBindings. Remove orphan context agents that duplicate upstream work.",
    "Recipient lists bound to /attendees or /to may use required_value sources with valueType array.",
    "For required_value_source_policy issues, align sourceKind with lifecycle: workflow_config uses stable_config, runtime_input uses operator_input, and matching binding provenance.",
    "For unknown_required_value or invalid_binding_source issues, do not preserve the dangling binding. If it merely restates a semantic tool instruction such as /prompt or /query, remove the binding and put the instruction in semanticAgents.task. Otherwise declare the genuinely operator-supplied value in requiredValues with the correct lifecycle, sourceKind, provenance, and surface.",
    "For generated_passthrough issues on /attendees, /to, or other identity fields, replace agent_output with a required_value from input.contacts_csv or input.audience_id.",
    "For incompatible_binding issues on boolean targets, use valueType boolean on the requiredValue, add a boolean artifact field, or remove the optional binding.",
    "Runtime inputs with lifecycle runtime_input and sourceKind operator_input must use status resolved.",
    "Approval is already enforced by the compiled confirm_action interaction. Remove required values, bindings, and unresolved issues for approval confirmation, approver lists, approval enforcement, confirm.send, or approval tokens.",
    "Remove every requiredValues entry reported as unused_required_value. Do not retain it or invent a consumer for it.",
    "For unused_required_value timezone or cron, delete that requiredValue and set schedule.timezone or schedule.cron instead.",
    "Match action annotation effect to contract declaredRisk. Integer action fields require integer artifact fields or stable_config scalars.",
    "For incompatible_binding issues, change or remove the binding according to the exact source and target types in the issue. Never bind an optional action field without a type-compatible source.",
    "For missing_required_binding issues, add an explicit source for that exact required target path. If an upstream agent produces it, bind from agent_output. Otherwise declare a requiredValue the operator supplies (workflow_config for stable settings like datetimes, recipients, locations; runtime_input for per-run decisions) and bind it. Only preserve an unresolved binding issue if the value is genuinely neither operator-suppliable nor agent-derivable — which is rare; recipients, attendees, datetimes, durations, and locations are always operator-suppliable.",
    "For input_surface_type_mismatch issues, fix the surface to match the valueType: array required values use input.contacts_csv; scalar string ids use input.audience_id; prose/links/datetimes use input.text. A recipient group or attendee list reported as an array MUST switch from input.audience_id to input.contacts_csv.",
    "For an unresolved issue stating that concrete recipient emails cannot be resolved from a group/team/audience name, do NOT keep it. Replace it with a recipient requiredValue (surface input.contacts_csv, valueType array, lifecycle workflow_config, sourceKind stable_config) bound to the send action recipient field so the operator supplies the addresses.",
    "For text_artifact_needs_json_fields issues, change the producer outputArtifact to representation json and declare every named field referenced by downstream bindings, such as /subject and /body for email actions.",
    "For text_artifact_fields issues, either set fields to [] and consume /text, or change the artifact to json when multiple named outputs are semantically required.",
    "Remove bindings whose target paths are absent from the receiving agent input contract, or explicitly shape that input contract when the binding is semantically required.",
    "For unknown_source_path or connector_input_path_used_as_source issues: connector nodes never expose /input. Remove the binding and instead bind from the semantic agent outputArtifact field that produces the same content. Add the missing field to that outputArtifact if needed.",
    "For unknown_binding_source or artifact_id_used_as_node_id issues: replace source.nodeId with the exact id of the producing semanticAgent, not its outputArtifact.id. Scan every binding in semanticAgents and selectedActions and verify each source.nodeId matches a declared agent id.",
    "For unresolved_decision or unresolved_binding issues whose message describes a runtime edge case (zero results, empty data, conditional fallback), remove the issue — set blocksApproval false or drop it. These are agent runtime concerns, not planning blockers.",
    "Reclassify requiredValues that describe loop settings, limits, timing, permanent filters, or recipient identity from runtime_input to workflow_config. Reclassify values that depend on per-run agent output from workflow_config to runtime_input with timing before_step or before_send.",
    "Before returning, cross-check every required_value binding source.key against requiredValues. The corrected IR must contain no dangling required_value references.",
    "For invalid_source_path_syntax issues, rewrite the path with slash-separated segments exactly as suggested in the issue.",
    "For opaque_connector_output_path issues, stop drilling into undeclared connector output. Rebind to a listed outputPaths value or follow the referenced contract planningHints for chaining decisions.",
    "Audit all source.nodeId and source.path pairs against semantic outputArtifact.fields, connector outputPaths, and referenced contract planningHints before returning the corrected IR.",
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
      reasoningEffort: process.env.TALLEI_LOOP_BUILDER__OPENAI_REASONING_EFFORT ? "low" : "medium",
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

export function validateOutboundDeliveryPlan(input: {
  planningIR: LoopPlanningIR;
  provider?: string;
  connectorContracts: ToolContract[];
}): PlanningCompilationIssue[] {
  const provider = input.provider?.trim() ?? "";
  const providerIdentity = normalizeProviderIdentity(provider);
  if (!providerIdentity || provider.toLowerCase() === "none") return [];

  const matchesProvider = (contractRef: string) => {
    const toolkit = parseConnectorActionToolRef(contractRef)?.toolkit ?? "";
    return normalizeProviderIdentity(toolkit) === providerIdentity;
  };
  const discoveredProviderContracts = input.connectorContracts.filter((contract) => matchesProvider(contract.toolRef));
  if (discoveredProviderContracts.length === 0) {
    return [{
      code: "required_external_capability_undiscovered",
      message: `No exact ${provider} connector contracts were discovered for the required outbound delivery capability.`,
      path: provider,
    }];
  }

  const providerActions = input.planningIR.selectedActions.filter((action) => matchesProvider(action.contractRef));
  if (providerActions.length === 0) {
    return [{
      code: "requested_provider_action_missing",
      message: `Outbound delivery requires at least one selected action from the explicitly requested provider ${provider}.`,
      path: provider,
    }];
  }

  const finalSemanticAgentId = input.planningIR.semanticAgents.at(-1)?.id;
  const actionsById = new Map(input.planningIR.selectedActions.map((action) => [action.id, action]));
  const reachesFinalSemanticOutput = (actionId: string, visited = new Set<string>()): boolean => {
    if (!finalSemanticAgentId || visited.has(actionId)) return false;
    visited.add(actionId);
    const action = actionsById.get(actionId);
    if (!action) return false;
    return action.bindings.some((binding) => {
      if (binding.source.kind === "agent_output") return binding.source.nodeId === finalSemanticAgentId;
      if (binding.source.kind === "connector_output" && binding.source.nodeId) {
        return reachesFinalSemanticOutput(binding.source.nodeId, visited);
      }
      return false;
    });
  };
  const providerWriteActions = providerActions.filter((action) => action.annotation.effect !== "read_external");
  if (!providerWriteActions.some((action) => reachesFinalSemanticOutput(action.id))) {
    return [{
      code: "external_delivery_missing_lineage",
      message: `Outbound delivery through ${provider} must include a matching-provider write action with declared data lineage from the final semantic artifact.`,
      path: provider,
    }];
  }
  return [];
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
  const specRequiredActions = input.noSlopSpec
    ? deriveRequiredConnectorActionsFromSpec(input.noSlopSpec.specJson)
    : [];
  const requiredActions = input.noSlopSpec
    ? [
        ...input.noSlopSpec.specJson.connectorPolicy.allowedReadActions,
        ...input.noSlopSpec.specJson.connectorPolicy.allowedWriteActions,
        ...specRequiredActions,
      ]
    : [];
  const connectorContracts = input.discoveredToolContracts ?? [];
  if (requiredActions.length > 0 && connectorContracts.length === 0) {
    throw new Error("Graph generation requires persisted connector contracts discovered before drafting");
  }
  const internalContracts = baseRegistry.toolContracts.filter((contract) => contract.provider === "internal");
  reportLoopBuilderProgress({
    stage: "contract_loading",
    message: `Loaded ${connectorContracts.length} persisted connector contracts and ${internalContracts.length} internal contracts`,
    status: "completed",
    details: {
      connectorContracts: connectorContracts.map((contract) => ({
        toolRef: contract.toolRef,
        name: contract.name,
        connected: contract.constraints.connected ?? false,
        risk: contract.constraints.risk ?? null,
        toolkitVersion: contract.constraints.toolkitVersion ?? null,
        requiredInputPaths: Array.isArray(contract.inputSchema.required) ? contract.inputSchema.required : [],
      })),
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
        input: { attempt },
        output: { compilationIssues, stopReason: canRetryTransport ? null : failureReason },
      }));
      if (canRetryTransport) continue;
      break;
    }
    lastAttemptFailedBeforePlanning = false;
    planningIR = result.planningIR;
    model = result.model;
    planningIR.schedule = {
      cron: normalizeDesignCron(planningIR.schedule.cron.trim(), prompt),
      timezone: planningIR.schedule.timezone.trim(),
    };
    compiled = compileLoopPlanningIR({
      planningIR,
      contracts: [...internalContracts, ...connectorContracts],
    });
    let issuesAfter = compiled.ok ? validateOutboundDeliveryPlan({
      planningIR,
      provider: input.noSlopSpec?.specJson.delivery.provider,
      connectorContracts,
    }) : compiled.issues;
    if (compiled.ok && issuesAfter.length > 0) {
      compiled = { ok: false, issues: issuesAfter };
    }
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
      input: { attempt, compilationIssues: compilationIssues ?? [] },
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
          searchPlan: { queries: [] },
          ...(input.noSlopSpec?.intentContext ? { intentContext: input.noSlopSpec.intentContext } : {}),
        },
        planningIRVersion: "v2",
        planningIR: planningIR as unknown as Record<string, unknown>,
        discoveredToolContracts: plannedConnectorContracts as unknown as Array<Record<string, unknown>>,
        ...(profile ? { workflowUserProfile: profile } : {}),
      },
    },
    delivery,
    connectorPolicy: compiled.compiled.connectorPolicy,
    inputRequirements: compiled.compiled.inputRequirements,
    operatorInteractionPlan: compiled.compiled.operatorInteractionPlan,
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
        stage: "persisted_connector_contracts",
        input: { prompt },
        output: { discoveredTools: connectorContracts.length },
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
