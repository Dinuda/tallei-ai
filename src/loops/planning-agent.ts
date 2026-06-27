import { generateText } from "ai";

import { config } from "../config/index.js";
import { getStreamingLanguageModel } from "../providers/ai/streaming/language-model.js";
import type { TestRunScenario } from "./conductor-tools.js";
import type { LoopSpec } from "./spec.js";
import {
  plannerDecisionSchema,
  type ConnectorPlaybook,
  type PlannerDecision,
  type ToolPlannerCard,
} from "./spec.js";
import { getMissingSlots } from "./patch.js";
import { getPendingConnectorOutcomes } from "./task-decomposition.js";
import { summarizeToolForPlanner } from "./tool-planner-card.js";
import { compactStepHistoryForPlanner } from "./tool-result-compact.js";

const DEFAULT_AGENT_INSTRUCTIONS = "Achieve the stated outcome using only the bound tools.";

const RUNTIME_PLANNER_RULES = [
  "Only call tools listed in Available tools (by toolId).",
  "If run history already has subject and snippet for the target message, do not call email.read again.",
  "For fetch-by-id use email.get with message_id from history or trigger context — never id: in query.",
  "Snippets are sufficient for triage and draft; full MIME payloads are disabled at runtime.",
  "If a prior tool call failed with missing fields, retry with corrected args or pick a different catalog tool.",
  "Do not finish after a single failed tool call unless no catalog tool can satisfy the goal.",
].join("\n");

function formatConnectorPlaybookSection(playbook: ConnectorPlaybook): string {
  const parts: string[] = ["Connector playbook (from compile):"];
  if (playbook.workflowSteps?.length) {
    parts.push(`Workflow steps:\n${playbook.workflowSteps.map((s) => `- ${s}`).join("\n")}`);
  }
  if (playbook.pitfalls?.length) {
    parts.push(`Pitfalls:\n${playbook.pitfalls.map((p) => `- ${p}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

type RuntimeToolCatalogEntry = {
  id: string;
  capability: string;
  connector: string;
  actionSlug: string;
  plannerCard: ToolPlannerCard;
};

function buildRuntimePlannerBody(input: {
  planOutcome: string;
  planGoal: string;
  agentInstructions?: string;
  successCriteria?: string[];
  toolCatalog: RuntimeToolCatalogEntry[];
  stepHistory: unknown[];
  workspaceMemory?: string[];
  connectorPlaybook: ConnectorPlaybook;
  triggerContext?: string;
  testRunPrefix?: string;
  testRunScenario?: TestRunScenario;
}): string {
  const tools = input.toolCatalog.map((tool) => summarizeToolForPlanner(tool));
  const playbookSection = formatConnectorPlaybookSection(input.connectorPlaybook);
  return [
    input.testRunPrefix,
    input.testRunScenario
      ? [
          `Scenario: ${input.testRunScenario.label}`,
          input.testRunScenario.context ? `Context: ${input.testRunScenario.context}` : "",
          input.testRunScenario.triggerPayload
            ? `Simulated trigger payload:\n${JSON.stringify(input.testRunScenario.triggerPayload, null, 2)}`
            : "",
        ].filter(Boolean).join("\n")
      : "",
    `Outcome: ${input.planOutcome}`,
    `Operational brief: ${input.agentInstructions ?? DEFAULT_AGENT_INSTRUCTIONS}`,
    `Context (user's original goal): ${input.planGoal}`,
    input.successCriteria?.length
      ? `Success criteria: ${input.successCriteria.join("; ")}`
      : "",
    playbookSection,
    input.triggerContext
      ? `Trigger context (this run only):\n${input.triggerContext}`
      : "",
    `Available tools: ${JSON.stringify(tools)}`,
    input.workspaceMemory?.length
      ? `Workspace context:\n${input.workspaceMemory.join("\n")}`
      : "",
    `Run history:\n${JSON.stringify(compactStepHistoryForPlanner(input.stepHistory))}`,
    "Respond with JSON only (no markdown). Use exactly one shape:",
    '{"kind":"tool_call","toolId":"<tool id from catalog>","args":{...},"reasoning":"..."}',
    '{"kind":"finish","summary":"..."}',
    "The kind field is required.",
    RUNTIME_PLANNER_RULES,
    input.testRunPrefix
      ? "Complete in one step: call exactly one tool with args from the scenario/trigger payload, OR finish if no tool is needed."
      : "",
  ].filter(Boolean).join("\n\n");
}

export function buildConductorSystemPrompt(input: {
  workspaceName?: string;
  spec: LoopSpec;
  connectedToolkits: Array<{ slug: string; name: string; connected: boolean }>;
}): string {
  const missing = getMissingSlots(input.spec);
  const hasBlueprint = Boolean(input.spec.taskBlueprint?.outcomes.length);
  const connectorsPending = getPendingConnectorOutcomes(input.spec.taskBlueprint).length;
  const connected = input.connectedToolkits
    .map((t) => `${t.slug}${t.connected ? "*" : ""}`)
    .join(", ") || "none";

  const nextStep = !hasBlueprint
    ? "patchLoopSpec(intent + taskBlueprint)."
    : connectorsPending
      ? "discoverConnectorsForBlueprint → autoApplyConnector? patch : pickConnectorApp (tool call) → patch selectedConnector."
      : missing.length
        ? `discoverBindings/listTriggers + patchLoopSpec (${missing.join(", ")}).`
        : "compileLoop → testRunLoop → presentReplyOptions → activateLoop when user confirms.";

  return [
    "You are Tallei's Conductor. Own loop configuration via patchLoopSpec and UI tools.",
    "Use pickConnectorApp, askQuestion, presentReplyOptions as tool calls — never replace them with plain-text-only questions in chat.",
    "",
    "## First principles",
    "- Resolve WHAT must be true at the end, not which API calls run.",
    "- intent.goal = user words; intent.outcome = one testable end state you write.",
    "- Patch intent + taskBlueprint on the first turn (inline intent analysis, no separate analyst).",
    "- Draft AND send both mentioned without clear order → askQuestion(delivery_mode) before connectors.",
    "- Default one app for trigger/receive/draft/send unless user asked for separate receive vs send apps.",
    "",
    "## Ownership",
    "- Resolve compile blockers with tools; no configuration checklists or capability-bundle questions.",
    `- Write agent.instructions from outcome + successCriteria; fallback only if needed: "${DEFAULT_AGENT_INSTRUCTIONS}"`,
    "- Auto-apply discoverBindings.suggestedBindings unless needsUserChoice (use discovery askOptions).",
    "- Customer-facing sends → approval.mode ask with email.send / support.reply.send in sensitiveCapabilities.",
    "- After patching, briefly tell the user what you chose (plain language, key actions).",
    "",
    "## Sequence",
    "1. patchLoopSpec — intent, taskBlueprint, agent, approval?",
    "2. askQuestion — only if delivery_mode (draft vs send) still ambiguous.",
    "3. discoverConnectorsForBlueprint once → autoApplyConnector? patchLoopSpec(selectedConnector) : pickConnectorApp → patch after user pick.",
    "4. listTriggers + discoverBindings → patch bindings, event trigger, output (blocked until connectors chosen).",
    "5. compileLoop → testRunLoop → presentReplyOptions → activateLoop after user confirms.",
    "",
    "## Connectors & auto-apply",
    "- autoApplyConnector: exactly one connected app is also #1 recommended → patch immediately; skip pickConnectorApp.",
    "- Otherwise MUST call pickConnectorApp (UI app cards). Connected * boosts rank only.",
    "- Forbidden: askQuestion Yes/No to confirm an app; hand-built connector lists; per-role options (Trigger/Source/Send).",
    "",
    "## Tool playbook",
    "patchLoopSpec | discoverConnectorsForBlueprint | pickConnectorApp | discoverBindings | listTriggers | askQuestion (business forks) | presentReplyOptions (compile/test/activate chips) | connectToolkit | compileLoop | testRunLoop | activateLoop | listConnectorCatalog({ toolkit }) scoped lookup | listConnectors/listActions (secondary).",
    "Event triggers: source = connector toolkit (gmail). composioSlug = exact slug from listTriggers (GMAIL_NEW_GMAIL_MESSAGE). patchLoopSpec rejects toolkit names in composioSlug; compile verifies against Composio catalogue.",
    "",
    "## Technical defaults",
    "New mail → event trigger (not email.receive binding). Fetch/list → email.read.",
    "",
    input.workspaceName ? `Workspace: ${input.workspaceName}` : "",
    `Connected (*=connected): ${connected}`,
    missing.length ? `Compile blockers: ${missing.join(", ")}` : "Compile blockers: none",
    `Next: ${nextStep}`,
    `Spec JSON:\n${JSON.stringify(input.spec)}`,
  ].filter(Boolean).join("\n");
}

/** @deprecated Use buildConductorSystemPrompt */
export const buildPlannerSystemPrompt = buildConductorSystemPrompt;

export async function runPlannerDecision(
  prompt: string,
  options?: { timeoutMs?: number; userId?: string },
): Promise<PlannerDecision> {
  const timeoutMs = options?.timeoutMs ?? config.plannerRequestTimeoutMs;
  const abortController = timeoutMs > 0 ? new AbortController() : null;
  const timer = abortController
    ? setTimeout(() => abortController.abort(), timeoutMs)
    : null;
  try {
    const { text } = await generateText({
      model: getStreamingLanguageModel("planner", { userId: options?.userId }),
      system: "You are Tallei's loop runtime planner. Reply with a single JSON object only.",
      prompt,
      ...(abortController ? { abortSignal: abortController.signal } : {}),
    });
    return parsePlannerDecisionText(text);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildTestRunPlannerPrompt(input: {
  planOutcome: string;
  planGoal: string;
  agentInstructions?: string;
  successCriteria?: string[];
  scenario: TestRunScenario;
  toolCatalog: RuntimeToolCatalogEntry[];
  stepHistory: unknown[];
  connectorPlaybook: ConnectorPlaybook;
}): string {
  return buildRuntimePlannerBody({
    planOutcome: input.planOutcome,
    planGoal: input.planGoal,
    agentInstructions: input.agentInstructions,
    successCriteria: input.successCriteria,
    toolCatalog: input.toolCatalog,
    stepHistory: input.stepHistory,
    connectorPlaybook: input.connectorPlaybook,
    testRunPrefix: "TEST RUN — simulated execution only. No real side effects.",
    testRunScenario: input.scenario,
  });
}

export function buildRuntimePlannerPrompt(input: {
  planOutcome: string;
  planGoal: string;
  agentInstructions?: string;
  successCriteria?: string[];
  toolCatalog: RuntimeToolCatalogEntry[];
  stepHistory: unknown[];
  workspaceMemory?: string[];
  connectorPlaybook: ConnectorPlaybook;
  triggerContext?: string;
}): string {
  return buildRuntimePlannerBody({
    planOutcome: input.planOutcome,
    planGoal: input.planGoal,
    agentInstructions: input.agentInstructions,
    successCriteria: input.successCriteria,
    toolCatalog: input.toolCatalog,
    stepHistory: input.stepHistory,
    workspaceMemory: input.workspaceMemory,
    connectorPlaybook: input.connectorPlaybook,
    triggerContext: input.triggerContext,
  });
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizePlannerDecision(raw: unknown): unknown {
  const row = asRecord(raw);
  if (!row) return raw;

  if (row.kind === "tool_call" || row.kind === "finish") return row;

  if (typeof row.summary === "string" && row.summary.trim()) {
    return { kind: "finish", summary: row.summary.trim() };
  }

  if (typeof row.toolId === "string" && row.toolId.trim()) {
    const args = asRecord(row.args) ?? {};
    return {
      kind: "tool_call",
      toolId: row.toolId.trim(),
      args,
      ...(typeof row.reasoning === "string" ? { reasoning: row.reasoning } : {}),
    };
  }

  return raw;
}

export function parsePlannerDecisionText(text: string): PlannerDecision {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown;
  return plannerDecisionSchema.parse(normalizePlannerDecision(parsed));
}
