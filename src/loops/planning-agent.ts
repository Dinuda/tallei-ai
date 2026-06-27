import { generateText } from "ai";

import { config } from "../config/index.js";
import { getStreamingLanguageModel } from "../providers/ai/streaming/language-model.js";
import type { TestRunScenario } from "./conductor-tools.js";
import type { LoopSpec } from "./spec.js";
import { plannerDecisionSchema, type PlannerDecision } from "./spec.js";
import { getMissingSlots } from "./patch.js";
import { summarizeToolForPlanner } from "./tool-schema.js";

const DEFAULT_AGENT_INSTRUCTIONS = "Achieve the stated outcome using only the bound tools.";

export function buildConductorSystemPrompt(input: {
  workspaceName?: string;
  spec: LoopSpec;
  connectedToolkits: Array<{ slug: string; name: string; connected: boolean }>;
}): string {
  const missing = getMissingSlots(input.spec);
  const intentLooksConcrete =
    !/^draft\b/i.test(input.spec.intent.goal.trim())
    && !/^draft\b/i.test(input.spec.intent.outcome.trim())
    && input.spec.intent.goal.trim().length > 12;

  return [
    "You are Tallei's Conductor. You own loop configuration end-to-end.",
    "The user states intent; you decide triggers, bindings, agent behavior, approval, and output — then patch the spec with patchLoopSpec.",
    "Your bar: only interrupt the user when their preference materially changes what the loop does. Everything else is your job.",
    "",
    "## Ownership (critical)",
    "- Resolve compile blockers yourself using tools — do not walk the user through a configuration checklist.",
    "- Never ask the user to pick capability bundles (e.g. 'Read & Send' vs 'Read, Draft & Send'). Infer outcomes from intent, call discoverBindings, patch bindings.",
    "- Never ask 'default instructions vs custom instructions'. Write agent.instructions yourself from intent.goal + intent.outcome + successCriteria. Use a concise operational brief; only the generic fallback if you truly have nothing specific:",
    `  "${DEFAULT_AGENT_INSTRUCTIONS}"`,
    "- After you patch the spec, briefly tell the user what you chose and why (plain language, mention key Composio actions when relevant).",
    "",
    "## Outcome-first toolkit planning (MANDATORY before bindings)",
    "Never pick a connector because it is connected. Connected apps are recommendations only.",
    "Forbidden until connector choices are confirmed: discoverBindings, listTriggers, patchLoopSpec.bindings, patchLoopSpec trigger/event, patchLoopSpec output.connector.",
    "Required sequence:",
    "1. decomposeTask → patchLoopSpec({ taskBlueprint }) with outcomes.",
    "2. discoverConnectorsForBlueprint once → pickConnectorApp (do NOT use askQuestion for connector choice) → patchLoopSpec({ taskBlueprint }) with selectedConnector on all pending outcomes from the user's app pick.",
    "3. Only when ALL outcomes are chosen/skipped: listTriggers + discoverBindings → patch bindings, trigger, output, agent. Resolve trigger/event details here — never in the connector pick step.",
    "Do NOT call listConnectors or listActions to select connectors. listConnectorCatalog is browse-only.",
    "",
    "## Connector pick vs askQuestion (critical)",
    "- Connector app choice: discoverConnectorsForBlueprint → pickConnectorApp only. Each app appears ONCE (Gmail, Outlook, Zendesk). Never duplicate the same app for trigger/source/destination.",
    "- Forbidden in connector pick: role labels (Trigger, Source, Read, Send), per-outcome options, or hand-built option lists.",
    "- askQuestion is ONLY for genuine business forks: approval before send, schedule frequency, output destination when intent is unclear.",
    "- NEVER ask about Composio actions, API methods, fetch strategies, message IDs, filters, or implementation details. Auto-apply discoverBindings.suggestedBindings.",
    "- When discoverBindings.needsUserChoice=true, use the exact askOptions from discovery (plain-language labels) — never invent technical options.",
    "",
    "## Tool playbook",
    "- listConnectorCatalog — browse full catalogue (do not auto-pick from it).",
    "- decomposeTask — required first step for new loops.",
    "- discoverConnectorsForBlueprint — required once after decomposeTask; returns ranked apps (each once) with top 5 recommended.",
    "- pickConnectorApp — present app picker after discovery; optional question text only — never pass options.",
    "- discoverBindings — Composio actions within a chosen connector.",
    "- listTriggers — exact composioSlug for event triggers.",
    "- patchLoopSpec — persist taskBlueprint, bindings, trigger, output, agent immediately.",
    "- connectToolkit — when user picks an unconnected app.",
    "- listConnectors / listActions — secondary; prefer catalogue + discovery tools.",
    "- compileLoop — freeze the current spec and compile it into a runnable plan. Call when the user agrees to go live and compile blockers are resolved.",
    "- testRunLoop — smoke test once before go-live (scenario only). Do NOT re-run if a test already passed on this compiled plan.",
    "- activateLoop — after a passing testRunLoop and user confirms. Never call testRunLoop again solely to satisfy activateLoop.",
    "- presentReplyOptions — when you ask the user to confirm compile, test, activate, or any yes/no: call this with 2–4 chips (label + message). Example labels: \"Yes, compile and test\", \"Make changes first\".",
    "",
    "## Binding & trigger rules",
    "- Event-driven loops: use event triggers (not email.receive bindings) for 'on each new message'.",
    "- Mailbox fetch/list: email.read (not email.receive).",
    "- Pick connectors from discoverConnectorsForBlueprint; pick actions from discoverBindings.",
    "",
    input.spec.taskBlueprint
      ? `Current task blueprint:\n${JSON.stringify(input.spec.taskBlueprint, null, 2)}`
      : "No task blueprint yet — run decomposeTask after intent is clear.",
    intentLooksConcrete
      ? "Intent appears concrete enough to configure — proceed with discovery and patching unless the user contradicts."
      : "Intent may still be vague — clarify the goal with one askQuestion before binding tools, unless the user's latest message already made it clear.",
    input.workspaceName ? `Workspace: ${input.workspaceName}` : "",
    `Current spec JSON:\n${JSON.stringify(input.spec, null, 2)}`,
    missing.length > 0
      ? `Compile blockers (resolve autonomously): ${missing.join(", ")}`
      : "No compile blockers — when the user agrees to go live: compileLoop → testRunLoop (dynamic scenario) → present results → activateLoop only after pass + user confirms. Use presentReplyOptions when asking to compile, test, or activate.",
    `Connected toolkits (recommendation hints only — still ask the user): ${input.connectedToolkits.map((t) => `${t.slug}(${t.connected ? "connected" : "not connected"})`).join(", ") || "none"}`,
  ].filter(Boolean).join("\n\n");
}

/** @deprecated Use buildConductorSystemPrompt */
export const buildPlannerSystemPrompt = buildConductorSystemPrompt;

export async function runPlannerDecision(
  prompt: string,
  options?: { timeoutMs?: number; userId?: string },
): Promise<PlannerDecision> {
  const timeoutMs = Math.max(5_000, options?.timeoutMs ?? config.plannerRequestTimeoutMs);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const { text } = await generateText({
      model: getStreamingLanguageModel("planner", { userId: options?.userId }),
      system: "You are Tallei's loop runtime planner. Reply with a single JSON object only.",
      prompt,
      abortSignal: abortController.signal,
    });
    return parsePlannerDecisionText(text);
  } finally {
    clearTimeout(timer);
  }
}

export function buildTestRunPlannerPrompt(input: {
  planGoal: string;
  scenario: TestRunScenario;
  toolCatalog: Array<{
    id: string;
    capability: string;
    connector: string;
    actionSlug: string;
    inputSchema: Record<string, unknown>;
  }>;
  stepHistory: unknown[];
}): string {
  const tools = input.toolCatalog.map((tool) => summarizeToolForPlanner(tool));
  return [
    "TEST RUN — simulated execution only. No real side effects.",
    `Scenario: ${input.scenario.label}`,
    input.scenario.context ? `Context: ${input.scenario.context}` : "",
    input.scenario.triggerPayload
      ? `Simulated trigger payload:\n${JSON.stringify(input.scenario.triggerPayload, null, 2)}`
      : "",
    `Goal: ${input.planGoal}`,
    `Available tools: ${JSON.stringify(tools)}`,
    `Run history:\n${JSON.stringify(input.stepHistory)}`,
    "Complete in one step: call exactly one tool with args from the scenario/trigger payload, OR finish if no tool is needed.",
    "Respond with JSON only (no markdown). Use exactly one shape:",
    '{"kind":"tool_call","toolId":"<tool id from catalog>","args":{...},"reasoning":"..."}',
    '{"kind":"finish","summary":"..."}',
    "The kind field is required.",
    "Use only fields listed in requiredFields/optionalFields for each tool.",
  ].filter(Boolean).join("\n\n");
}

export function buildRuntimePlannerPrompt(input: {
  planGoal: string;
  toolCatalog: Array<{
    id: string;
    capability: string;
    connector: string;
    actionSlug: string;
    inputSchema: Record<string, unknown>;
  }>;
  stepHistory: unknown[];
  workspaceMemory?: string[];
}): string {
  const tools = input.toolCatalog.map((tool) => summarizeToolForPlanner(tool));
  return [
    `Goal: ${input.planGoal}`,
    `Available tools: ${JSON.stringify(tools)}`,
    input.workspaceMemory?.length
      ? `Workspace context:\n${input.workspaceMemory.join("\n")}`
      : "",
    `Run history:\n${JSON.stringify(input.stepHistory)}`,
    "Respond with JSON only (no markdown). Use exactly one shape:",
    '{"kind":"tool_call","toolId":"<tool id from catalog>","args":{...},"reasoning":"..."}',
    '{"kind":"finish","summary":"..."}',
    "The kind field is required.",
    "Use only fields listed in requiredFields/optionalFields for each tool.",
    "If a prior tool call failed with missing fields, retry with corrected args or pick a different tool from the catalog.",
    "Do not finish after a single failed tool call unless no catalog tool can satisfy the goal.",
  ].filter(Boolean).join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
