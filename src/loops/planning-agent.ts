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

const DEFAULT_AGENT_INSTRUCTIONS =
  "Achieve the stated outcome using only the bound tools.";

const RUNTIME_PLANNER_RULES = [
  "Only call tools listed in Available tools (by toolId).",
  "Planner args are suggestions only; runtime resolves required Composio args from composioAction.inputInstructions.",
  "Do not invent required args. If a required arg source is unavailable, call the prerequisite action or finish with a clear blocker.",
  "Only provide a required arg yourself when that field's composioAction source explicitly includes type=planner.",
  "Follow each tool's behaviorInstructions and modifiedInputSchema; fields omitted from that schema are runner-controlled.",
  "If run history already contains sufficient output for the same tool with the same resolved arguments, consume that result instead of repeating the call.",
  "If a prior tool call failed with missing fields, retry with corrected args or pick a different catalog tool.",
  "Do not finish after a single failed tool call unless no catalog tool can satisfy the goal.",
  "Set finishOnSuccess=true and provide completionSummary when this tool call will satisfy the remaining outcome; otherwise omit both fields.",
].join("\n");

function formatConnectorPlaybookSection(playbook: ConnectorPlaybook): string {
  const parts: string[] = ["Connector playbook (from compile):"];
  if (playbook.workflowSteps?.length) {
    parts.push(
      `Workflow steps:\n${playbook.workflowSteps.map((s) => `- ${s}`).join("\n")}`,
    );
  }
  if (playbook.pitfalls?.length) {
    parts.push(
      `Pitfalls:\n${playbook.pitfalls.map((p) => `- ${p}`).join("\n")}`,
    );
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
  exhaustedToolIds?: string[];
}): string {
  const exhausted = new Set(input.exhaustedToolIds ?? []);
  const tools = input.toolCatalog
    .filter((tool) => !exhausted.has(tool.id))
    .map((tool) => summarizeToolForPlanner(tool));
  const playbookSection = formatConnectorPlaybookSection(
    input.connectorPlaybook,
  );
  return [
    input.testRunPrefix,
    input.testRunScenario
      ? [
          `Scenario: ${input.testRunScenario.label}`,
          input.testRunScenario.context
            ? `Context: ${input.testRunScenario.context}`
            : "",
          input.testRunScenario.triggerPayload
            ? `Simulated trigger payload:\n${JSON.stringify(input.testRunScenario.triggerPayload, null, 2)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
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
    '{"kind":"tool_call","toolId":"<tool id from catalog>","args":{},"reasoning":"...","finishOnSuccess":true,"completionSummary":"..."}',
    '{"kind":"finish","summary":"..."}',
    "The kind field is required.",
    RUNTIME_PLANNER_RULES,
    input.testRunPrefix
      ? "Complete in one step: call exactly one tool with args from the scenario/trigger payload, OR finish if no tool is needed."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildConductorSystemPrompt(input: {
  workspaceName?: string;
  spec: LoopSpec;
  confirmationHash: string;
  connectedToolkits: Array<{ slug: string; name: string; connected: boolean }>;
}): string {
  const missing = getMissingSlots(input.spec);
  const hasBlueprint = Boolean(input.spec.taskBlueprint?.outcomes.length);
  const connectorsPending = getPendingConnectorOutcomes(
    input.spec.taskBlueprint,
  ).length;
  const intentStatus = input.spec.intentDiscovery.status;
  const briefConfirmed = isOutcomeBriefConfirmed(input.spec);
  const connected =
    input.connectedToolkits
      .map((t) => `${t.slug}${t.connected ? "*" : ""}`)
      .join(", ") || "none";

  const nextStep =
    intentStatus === "pending"
      ? "analyzeIntent. If it returns nextQuestion, call askQuestion with it."
      : intentStatus === "needs_input"
        ? "askQuestion for the unresolved intent question only. Do not call analyzeIntent again—the server records the user's answer automatically."
      : !hasBlueprint
        ? "patchLoopSpec(taskBlueprint + agent + approval) from the ready intent analysis."
        : connectorsPending
          ? "discoverConnectorsForBlueprint → pickConnectorApp once per pending role → patch selectedConnector."
          : missing.length
            ? `discoverBindings/listTriggers + patchLoopSpec (${missing.join(", ")}).`
            : !briefConfirmed
                ? "Briefly introduce the config-driven review and call confirmOutcomeBrief."
              : "compileLoop → testRunLoop → presentReplyOptions → activateLoop when user confirms.";

  return [
    "You are Tallei’s Conductor. Guide a non-technical user from intent to an activated automation.",
    "Think in plain-language outcomes, not implementation details.",
    "Use interactive tools for choices: askQuestion, pickConnectorApp, confirmOutcomeBrief, presentReplyOptions. Never replace these with plain text.",
    "",
    "— Core rules —",
    "• Backend spec is the source of truth. Patch only when you have a new, confirmed value for the current phase—never rewrite unchanged data or re-patch the same value twice.  ",
    "• Ask at most one clarification question at a time and keep wording non-technical.  ",
    "• Never expose internal IDs, JSON, confirmation hashes, API slugs, action slugs, trigger slugs, or cron syntax to the user.",
    "",
    "— Tool ownership (do not omit) —",
    "• **analyzeIntent** – clarifies outcome, trigger, execution order, scope, destination, autonomy.  ",
    "• **askQuestion** – single follow-up question when analyzeIntent asks for it.  ",
    "• **patchLoopSpec** – writes spec; use only for new/changed values.  ",
    "• **discoverConnectorsForBlueprint** – reads the patched taskBlueprint, returns required app roles.  ",
    "• **pickConnectorApp** – user picks an app per role (never auto-select).  ",
    "• **listWorkspaceConnectors** – refreshes which workspace apps are connected; connection is never app-selection consent.  ",
    "• **discoverBindings / listTriggers** – provide concrete bindings, action & trigger slugs.  ",
    "• **confirmOutcomeBrief** – confirmation buttons shown with the Markdown review.  ",
    "• **presentReplyOptions** – quick-reply chips for yes/no/test/activate prompts.  ",
    "• **compileLoop / testRunLoop / activateLoop** – build, test, and turn on the automation.",
    "",
    "— Blueprint & patch flow —",
    "1. **Intent phase**  ",
    "   • analyzeIntent → askQuestion (if needed) → server records answer → READY.  ",
    "2. **Blueprint** (one-time)  ",
    "   • patchLoopSpec: taskBlueprint + agent + approval. Derive taskBlueprint.outcomes from executionOrder in the same order.  ",
    "3. **Connectors**  ",
    "   • discoverConnectorsForBlueprint → pickConnectorApp → patch selectedConnector.  ",
    "4. **Bindings & triggers**  ",
    "   • discoverBindings / listTriggers → patch bindings + trigger + output.  ",
    "5. **User confirmation**  ",
    "   • Write one short introductory sentence, then call confirmOutcomeBrief. The UI derives the review from the current spec.  ",
    "   • On confirm, patch status=confirmed with the current confirmation hash.  ",
    "6. **Build & launch**  ",
    "   • compileLoop → testRunLoop → presentReplyOptions → activateLoop (after user agrees).",
    "",
    "— Execution order —",
    "• analyzeIntent must output executionOrder as the ordered plain-language pipeline.  ",
    "• patchLoopSpec must map executionOrder to taskBlueprint.outcomes in the same order.  ",
    "• Array order is the pipeline. Use interleaved order for multi-step flows that revisit a source after a delivery step.  ",
    "",
    "— Safety —",
    "Treat sending, deleting, approving, paying, posting, or contacting people as sensitive. Use review-first approval unless the ready intent explicitly chooses auto-send.",
    "",
    "— Hard stops —",
    "No blueprint, connector, binding, trigger, or output patching during intent clarification.  ",
    "Never call analyzeIntent again after the user answered an intent question—the server records it automatically.  ",
    "Never call analyzeIntent twice in the same turn without new user input.  ",
    "Don’t proceed to connector selection before the blueprint exists.  ",
    "Don’t patch connector/binding/trigger/output fields in the initial blueprint patch.",
    "",
    "— Config-driven confirmation review —",
    "The UI derives the review card entirely from the current LoopSpec. Do not generate, restate, or pass title, stages, trigger text, approval copy, reversibility, or result fields to confirmOutcomeBrief.",
    "Write only one short introductory sentence. The tool's buttons ask the confirmation question.",
    "",
    "Available tools: analyzeIntent · askQuestion · patchLoopSpec · discoverConnectorsForBlueprint · pickConnectorApp · listWorkspaceConnectors · discoverBindings · listTriggers · confirmOutcomeBrief · presentReplyOptions · compileLoop · testRunLoop · activateLoop",
    "",
    input.workspaceName ? `Workspace: ${input.workspaceName}` : "",
    `Connected (*=connected): ${connected}`,
    missing.length
      ? `Compile blockers: ${missing.join(", ")}`
      : "Compile blockers: none",
    !briefConfirmed && missing.length === 0
      ? `Current confirmation hash (tool input only; never display): ${input.confirmationHash}`
      : "",
    `Next: ${nextStep}`,
    `Spec JSON:\n${JSON.stringify(input.spec)}`,
  ].filter(Boolean).join("\n\n");
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
      system:
        "You are Tallei's loop runtime planner. Reply with a single JSON object only.",
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
  exhaustedToolIds?: string[];
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
    exhaustedToolIds: input.exhaustedToolIds,
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
    ? (value as Record<string, unknown>)
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
      ...(typeof row.reasoning === "string"
        ? { reasoning: row.reasoning }
        : {}),
    };
  }

  return raw;
}

export function parsePlannerDecisionText(text: string): PlannerDecision {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown;
  return plannerDecisionSchema.parse(normalizePlannerDecision(parsed));
}
