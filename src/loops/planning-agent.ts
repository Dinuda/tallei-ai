import { generateText } from "ai";

import { config } from "../config/index.js";
import { getStreamingLanguageModel } from "../providers/ai/streaming/language-model.js";
import type { TestRunScenario } from "./conductor-tools.js";
import {
  plannerDecisionSchema,
  type ConnectorPlaybook,
  type ComposioActionInstruction,
  type LoopSpec,
  type PlannerDecision,
  type ToolPlannerCard,
} from "./spec.js";
import { getMissingSlots } from "./patch.js";
import { getPendingConnectorOutcomes } from "./task-decomposition.js";
import { summarizeToolForPlanner } from "./tool-planner-card.js";
import { compactStepHistoryForPlanner } from "./tool-result-compact.js";
import { isOutcomeBriefConfirmed } from "./outcome-brief.js";

const DEFAULT_AGENT_INSTRUCTIONS = "Achieve the stated outcome using only the bound tools.";

const RUNTIME_PLANNER_RULES = [
  "Only call tools listed in Available tools (by toolId).",
  "Planner args are suggestions only; runtime resolves required Composio args from composioAction.inputInstructions.",
  "Do not invent required args. If a required arg source is unavailable, call the prerequisite action or finish with a clear blocker.",
  "Only provide a required arg yourself when that field's composioAction source explicitly includes type=planner.",
  "Follow each tool's behaviorInstructions and modifiedInputSchema; fields omitted from that schema are runner-controlled.",
  "If run history already satisfies a tool's output instructions, consume that result instead of calling the tool again.",
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
  composioAction?: ComposioActionInstruction;
  modifiedInputSchema?: Record<string, unknown>;
  behaviorInstructions?: string[];
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
    '{"kind":"tool_call","toolId":"<tool id from catalog>","args":{},"reasoning":"..."}',
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
  const intentStatus = input.spec.intentDiscovery.status;
  const briefConfirmed = isOutcomeBriefConfirmed(input.spec);
  const connected = input.connectedToolkits
    .map((t) => `${t.slug}${t.connected ? "*" : ""}`)
    .join(", ") || "none";

  const nextStep = intentStatus === "pending" || intentStatus === "needs_input"
    ? "analyzeIntent, then askQuestion only when it returns a material unresolved question."
    : !hasBlueprint
    ? "patchLoopSpec(taskBlueprint + agent + approval) from the ready intent analysis."
    : connectorsPending
      ? "discoverConnectorsForBlueprint → pickConnectorApp once per pending role → patch selectedConnector."
      : missing.length
        ? `discoverBindings/listTriggers + patchLoopSpec (${missing.join(", ")}).`
        : !briefConfirmed
          ? "reviewOutcomeBrief → confirmOutcomeBrief → patch confirmation when accepted."
          : "compileLoop → testRunLoop → presentReplyOptions → activateLoop when user confirms.";

  return [
    "You are Tallei's Conductor. Own loop configuration via patchLoopSpec and UI tools.",
    "Use pickConnectorApp, askQuestion, confirmOutcomeBrief, and presentReplyOptions as tool calls — never replace interactive choices with plain text.",
    "",
    "## First principles",
    "- Resolve WHAT must be true at the end, not which API calls run.",
    "- intent.goal = user words; intent.outcome = one testable end state you write.",
    "- Call analyzeIntent on the initial request and again after each clarification answer.",
    "- Zero clarification questions is valid. Ask only when the answer materially changes outcome, safety/autonomy, trigger, scope, destination, or success criteria.",
    "- Ask at most one question at a time, using the highest-priority nextQuestion returned by analyzeIntent.",
    "- On Skip, record the recommended choice as source=recommended_assumption and show it in the outcome brief.",
    "- Never repeat a questionId already present in decisions or askedQuestionIds.",
    "",
    "## Ownership",
    "- Resolve compile blockers with tools; no configuration checklists or capability-bundle questions.",
    `- Write agent.instructions from outcome + successCriteria; fallback only if needed: "${DEFAULT_AGENT_INSTRUCTIONS}"`,
    "- Auto-apply discoverBindings.suggestedBindings unless needsUserChoice (use discovery askOptions).",
    "- Customer-facing sends → approval.mode ask with email.send / support.reply.send in sensitiveCapabilities.",
    "- After patching, briefly tell the user what you chose (plain language, key actions).",
    "",
    "## Sequence",
    "1. analyzeIntent → askQuestion only when nextQuestion exists; repeat analysis after the answer.",
    "2. patchLoopSpec — taskBlueprint, agent, approval from the ready analysis.",
    "3. discoverConnectorsForBlueprint once → pickConnectorApp separately for every returned role group → patch that outcome's selectedConnector.",
    "4. For each selected connector, listTriggers/discoverBindings → patch bindings + composioActions, event trigger, and output.",
    "5. reviewOutcomeBrief (server builds plain-language userSummary for the confirmation card) → confirmOutcomeBrief with briefHash, a plain-language question, and 2–4 user-facing options (option value = confirm | change_outcome | change_trigger | change_connectors | change_approvals | other). If confirmed, patch intentDiscovery.status=confirmed and the exact briefHash.",
    "6. compileLoop → testRunLoop → presentReplyOptions → activateLoop.",
    "",
    "## Connectors",
    "- Connector choice is always explicit. Never infer or auto-submit a connected app.",
    "- Use server-provided role groups and ranked picker options. Never hand-build connector lists.",
    "- Connected status boosts rank only. The picker shows five recommendations and searchable alternatives.",
    "- Reuse an earlier connector only after the user explicitly selects it for the next compatible role.",
    "",
    "## Outcome brief edits",
    "- confirmOutcomeBrief options must be plain English for non-technical users — never expose API slugs, action names, or connector IDs in labels.",
    "- confirm → patch intentDiscovery.status=confirmed with the exact current briefHash, then compile.",
    "- change_outcome/change_trigger/change_approvals → ask one focused follow-up, patch the answer, then rediscover affected configuration.",
    "- change_connectors → patch the relevant blueprint outcome back to pending without selectedConnector, then reopen its picker.",
    "- other → treat otherText as the requested edit. Never mark the brief confirmed for an edit action.",
    "",
    "## Tool playbook",
    "analyzeIntent | askQuestion | patchLoopSpec | discoverConnectorsForBlueprint | pickConnectorApp | discoverBindings | listTriggers | reviewOutcomeBrief | confirmOutcomeBrief | presentReplyOptions | connectToolkit | compileLoop | testRunLoop | activateLoop | listConnectorCatalog({ toolkit }) | listConnectors/listActions.",
    "Composio action execution: discoverBindings returns exact action slugs plus suggestedComposioActions. Always patch both bindings and composioActions together; bindings choose the tool, composioActions tell the runner how to fill inputs and extract outputs.",
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
