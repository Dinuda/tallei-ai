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
  buildPhase?: "intent" | "blueprint" | "connectors" | "bindings" | "review" | "compile" | "test" | "activation";
}): string {
  const missing = getMissingSlots(input.spec);
  const hasBlueprint = Boolean(input.spec.taskBlueprint?.outcomes.length);
  const connectorsPending = getPendingConnectorOutcomes(
    input.spec.taskBlueprint,
  ).length;
  const briefConfirmed = isOutcomeBriefConfirmed(input.spec);
  const connected =
    input.connectedToolkits
      .map((t) => `${t.slug}${t.connected ? "*" : ""}`)
      .join(", ") || "none";
  const exposeImplementationContext = !input.buildPhase
    || !["intent", "blueprint"].includes(input.buildPhase);

  const nextStep = input.buildPhase
    ? ({
        intent: "analyzeIntent once, then ask every returned business question in the same assistant turn. The server records the completed intent automatically.",
        blueprint: "Wait for the server-derived blueprint; do not call another tool.",
        connectors: "recommend apps, reuse a prior explicit app choice when discovery auto-resolves it, and ask only for remaining app choices.",
        bindings: "discover exact triggers and actions only from the selected apps. Ask at most one meaningful trigger-scope question, then save it with setBindingConfig.",
        review: "present the review and request explicit acceptance. The confirmation result is saved automatically.",
        compile: "compileLoop.", test: "testRunLoop.", activation: "request explicit confirmation, then activateLoop.",
      } as const)[input.buildPhase]
    : !hasBlueprint
      ? "analyzeIntent and complete its business questions; the server derives the blueprint automatically."
      : connectorsPending
        ? "discoverConnectorsForBlueprint → pickConnectorApp once per pending role → patch selectedConnector."
        : missing.length
          ? `discoverBindings/listTriggers for the unresolved runtime details (${missing.join(", ")}); the server saves valid results automatically.`
          : !briefConfirmed
              ? "Briefly introduce the specialist team review, call presentAgentTeam, then confirmOutcomeBrief."
            : "compileLoop → testRunLoop → presentReplyOptions → activateLoop when user confirms. If compileLoop fails on technical metadata, rerun discovery and compile again without repeating unchanged user choices.";

  return [
    "You are Tallei’s Conductor. Guide a non-technical user from intent to an activated automation.",
    "Think in plain-language outcomes, not implementation details.",
    "Use interactive tools for choices: askQuestion, pickConnectorApp, presentAgentTeam, confirmOutcomeBrief, presentReplyOptions. Never replace these with plain text.",
    "",
    "— Core rules —",
    "• Backend build state is the source of truth. Normal tool results are interpreted and persisted automatically; never ask the user to repeat a completed choice.  ",
    "• analyzeIntent must return at least one and at most four questions. It should return exactly one by default and add another only for an independent, material unresolved business choice; never fill the queue to four by default. Ask every returned question in the same assistant turn and keep wording non-technical. If no business choice is unresolved, it must return one outcome-focused confirmation question.  ",
    "• Never expose internal IDs, JSON, confirmation hashes, API slugs, action slugs, trigger slugs, or cron syntax to the user.",
    "",
    "— Tool ownership (do not omit) —",
    "• **analyzeIntent** – clarifies outcome, trigger, execution order, scope, destination, autonomy.  ",
    "• **askQuestion** – one queued follow-up question from analyzeIntent; emit one call per returned question.  ",
    "• **discoverConnectorsForBlueprint** – reads the patched taskBlueprint, returns required app roles.  ",
    "• **pickConnectorApp** – user picks unresolved apps; discovery may reuse an already-confirmed app for a later outcome.  ",
    "• **listWorkspaceConnectors** – refreshes which workspace apps are connected; connection is never app-selection consent.  ",
    "• **discoverBindings / listTriggers / setBindingConfig** – provide concrete bindings and save one optional trigger-scope choice.  ",
    "• **presentAgentTeam** – specialist roster grouped from blueprint outcomes.  ",
    "• **confirmOutcomeBrief** – confirmation buttons after the roster.  ",
    "• **presentReplyOptions** – quick-reply chips for yes/no/test/activate prompts.  ",
    "• **compileLoop / testRunLoop / activateLoop** – build, test, and turn on the automation.",
    "",
    "— Blueprint & patch flow —",
    "1. **Intent phase**  ",
    "   • analyzeIntent → askQuestion × N → server records answers → READY.  ",
    "2. **Blueprint** (server-derived)  ",
    "   • The server derives the ordered blueprint from analyzeIntent.executionOrder after all intent answers arrive.  ",
    "3. **Connectors**  ",
    "   • discoverConnectorsForBlueprint → narrate auto-resolved reuse → pickConnectorApp only for pending groups.  ",
    "4. **Bindings & triggers**  ",
    "   • discoverBindings / listTriggers → optional askQuestion → setBindingConfig. Ask exactly once only when discovery returns a meaningful trigger scope.  ",
    "5. **User confirmation**  ",
    "   • Write one short introductory sentence, call presentAgentTeam, then confirmOutcomeBrief. The UI renders the roster from the server-normalized team.  ",
    "   • The confirmOutcomeBrief answer is the review decision; never request a second confirmation.  ",
    "6. **Build & launch**  ",
    "   • compileLoop → testRunLoop → presentReplyOptions → activateLoop (after user agrees).",
    "",
    "— Execution order —",
    "• analyzeIntent must output executionOrder as the ordered plain-language pipeline.  ",
    "• Write each step description as a verb-first action phrase (e.g. \"Sends reply to customer\"), never a noun job title like \"Reply Sender\".  ",
    "• The server maps executionOrder to taskBlueprint.outcomes in the same order.  ",
    "• Array order is the pipeline. Use interleaved order for multi-step flows that revisit a source after a delivery step.  ",
    "",
    "— Safety —",
    "Treat sending, deleting, approving, paying, posting, or contacting people as sensitive. Use review-first approval unless the ready intent explicitly chooses auto-send.",
    "",
    "— Hard stops —",
    "No blueprint, connector, binding, trigger, or output patching during intent clarification.  ",
    "Never rerun analyzeIntent after valid intent questions are emitted; wait for their answers.  ",
    "Never call analyzeIntent twice in the same turn without new user input.  ",
    "Don’t proceed to connector selection before the blueprint exists.  ",
    "Never invent connector, binding, trigger, or output fields; only discovery results may supply them.",
    "",
    "— Specialist team review —",
    "Call presentAgentTeam with groups[] that group adjacent blueprint outcomes into coherent personas. Keep trigger outcomes separate. Include every outcome id exactly once in execution order. Never group across the approval boundary—drafting before review, sensitive delivery after review. Suggest ownershipSummary as a clear verb-first sentence describing what the persona does. The server derives professional job role titles from each group's steps and renders the roster.",
    "Do not generate or pass review summary fields to confirmOutcomeBrief.",
    "Write only one short introductory sentence before the roster tools. confirmOutcomeBrief supplies exactly two buttons—confirm and other—never a menu of change categories.",
    "",
    "Available tools: analyzeIntent · askQuestion · discoverConnectorsForBlueprint · pickConnectorApp · listWorkspaceConnectors · discoverBindings · listTriggers · setBindingConfig · presentAgentTeam · confirmOutcomeBrief · presentReplyOptions · compileLoop · testRunLoop · activateLoop",
    "",
    input.workspaceName ? `Workspace: ${input.workspaceName}` : "",
    exposeImplementationContext ? `Connected (*=connected): ${connected}` : "",
    exposeImplementationContext && missing.length
      ? `Compile blockers: ${missing.join(", ")}`
      : exposeImplementationContext ? "Compile blockers: none" : "",
    exposeImplementationContext && !briefConfirmed && missing.length === 0
      ? `Current confirmation hash (tool input only; never display): ${input.confirmationHash}`
      : "",
    `Next: ${nextStep}`,
    `Spec JSON:\n${JSON.stringify(input.spec)}`,
  ].filter(Boolean).join("\n\n");
}


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
