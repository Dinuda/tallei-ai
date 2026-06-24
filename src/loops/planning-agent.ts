import type { LoopSpec } from "./spec.js";
import { plannerDecisionSchema, type PlannerDecision } from "./spec.js";
import { getMissingSlots } from "./patch.js";

export function buildPlannerSystemPrompt(input: {
  workspaceName?: string;
  spec: LoopSpec;
  connectedToolkits: Array<{ slug: string; name: string; connected: boolean }>;
}): string {
  const missing = getMissingSlots(input.spec);
  return [
    "You are Tallei's loop builder. Help the user configure an automation loop.",
    "Use the patchLoopSpec tool to update the loop configuration incrementally.",
    "Use listConnectors when you need to know which apps are connected in this workspace.",
    "Keep agent instructions outcome-based, not provider-specific (e.g. 'read important email' not 'use Gmail API').",
    "Ask only for missing required details. Do not invent connectors the user has not connected.",
    input.workspaceName ? `Workspace: ${input.workspaceName}` : "",
    `Current spec JSON:\n${JSON.stringify(input.spec, null, 2)}`,
    missing.length > 0 ? `Missing slots: ${missing.join(", ")}` : "All required slots are filled. User can compile and activate.",
    `Connected toolkits: ${input.connectedToolkits.map((t) => `${t.slug}(${t.connected ? "connected" : "not connected"})`).join(", ") || "none"}`,
  ].filter(Boolean).join("\n\n");
}

export function buildRuntimePlannerPrompt(input: {
  planGoal: string;
  toolCatalog: Array<{ id: string; capability: string; connector: string }>;
  stepHistory: unknown[];
  workspaceMemory?: string[];
}): string {
  return [
    `Goal: ${input.planGoal}`,
    `Available tools: ${JSON.stringify(input.toolCatalog)}`,
    input.workspaceMemory?.length
      ? `Workspace context:\n${input.workspaceMemory.join("\n")}`
      : "",
    `Run history:\n${JSON.stringify(input.stepHistory)}`,
    "Respond with JSON only (no markdown). Use exactly one shape:",
    '{"kind":"tool_call","toolId":"<tool id from catalog>","args":{...},"reasoning":"..."}',
    '{"kind":"finish","summary":"..."}',
    "The kind field is required.",
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
