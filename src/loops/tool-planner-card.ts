import type { ToolPlannerCard } from "./spec.js";
import { summarizeInputSchema } from "./tool-schema.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function summarizeOutputFields(outputSchema: Record<string, unknown>): { fields: string[]; notes: string[] } {
  const row = asRecord(outputSchema) ?? {};
  const properties = asRecord(row.properties) ?? row;
  const fields = Object.keys(properties).filter((key) => key !== "required" && key !== "type");
  const notes: string[] = [];
  if (fields.includes("messages")) {
    notes.push("Runtime may compact messages[] to latest 2 with subject/sender/snippet only.");
  }
  return { fields: fields.slice(0, 12), notes };
}

function buildArgGuides(inputSchema: Record<string, unknown>): ToolPlannerCard["argGuides"] {
  const row = asRecord(inputSchema) ?? {};
  const properties = asRecord(row.properties) ?? row;
  const guides: ToolPlannerCard["argGuides"] = {};

  for (const [field, raw] of Object.entries(properties)) {
    if (field === "required" || field === "type") continue;
    const prop = asRecord(raw);
    if (!prop) continue;
    const description = typeof prop.description === "string" ? prop.description : undefined;
    const examples = Array.isArray(prop.examples)
      ? prop.examples.filter((e): e is string => typeof e === "string").slice(0, 3)
      : typeof prop.example === "string"
        ? [prop.example]
        : undefined;
    const constraints = Array.isArray(prop.enum)
      ? `enum: ${prop.enum.map(String).join(", ")}`
      : undefined;
    if (description || examples?.length || constraints) {
      guides[field] = { ...(description ? { description } : {}), ...(examples?.length ? { examples } : {}), ...(constraints ? { constraints } : {}) };
    }
  }
  return guides;
}

function gmailAntiPatterns(actionSlug: string, capability: string): string[] {
  const slug = actionSlug.toUpperCase();
  const patterns: string[] = [];
  if (capability === "email.read" || (slug.includes("FETCH") && !slug.includes("MESSAGE_ID") && !slug.includes("BY_ID"))) {
    patterns.push("Never use id:<messageId> in query — Gmail search has no id: operator.");
    patterns.push("Use from:, subject:, is:unread, in:inbox for search queries.");
  }
  if (capability === "email.get" || slug.includes("MESSAGE_ID") || slug.includes("BY_ID")) {
    patterns.push("Pass message_id from prior step or trigger context — not in query.");
  }
  return patterns;
}

export function buildPlannerCardFromSchemas(input: {
  actionSlug: string;
  capability: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  relatedActionSlugs?: string[];
  pitfalls?: string[];
}): ToolPlannerCard {
  const slug = input.actionSlug.toUpperCase();
  const isList = input.capability === "email.read"
    || (slug.includes("GMAIL") && slug.includes("FETCH") && !slug.includes("MESSAGE_ID") && !slug.includes("BY_ID"));
  const isGet = input.capability === "email.get"
    || slug.includes("MESSAGE_ID") || slug.includes("BY_ID") || slug.includes("BY_THREAD");

  const antiPatterns = [
    ...gmailAntiPatterns(input.actionSlug, input.capability),
    ...(input.pitfalls ?? []).slice(0, 4),
  ];

  const inputSummary = summarizeInputSchema(input.inputSchema);
  const argGuides = buildArgGuides(input.inputSchema);
  if (isList && !argGuides.query) {
    argGuides.query = {
      description: "Gmail search query (from:, subject:, is:unread, in:inbox). Not for API message IDs.",
      examples: ["in:inbox is:unread", "subject:site down"],
    };
  }
  if (isGet && inputSummary.required.includes("message_id") && !argGuides.message_id) {
    argGuides.message_id = {
      description: "Gmail API message resource ID from a prior list result or trigger context.",
    };
  }

  return {
    summary: input.description || input.actionSlug,
    whenToUse: isList
      ? "Search or list messages matching a Gmail query."
      : isGet
        ? "Fetch one message by API message_id."
        : undefined,
    whenNotToUse: isList
      ? "Not for fetch-by-id; use email.get with message_id instead."
      : isGet
        ? "Not for inbox search; use email.read with query instead."
        : undefined,
    argGuides,
    ...(input.outputSchema ? { outputSummary: summarizeOutputFields(input.outputSchema) } : {}),
    ...(antiPatterns.length > 0 ? { antiPatterns: [...new Set(antiPatterns)] } : {}),
    ...(input.relatedActionSlugs?.length ? { relatedActionSlugs: input.relatedActionSlugs } : {}),
  };
}

export function summarizeToolForPlanner(tool: {
  id: string;
  capability: string;
  connector: string;
  actionSlug: string;
  plannerCard: ToolPlannerCard;
}): Record<string, unknown> {
  return {
    id: tool.id,
    capability: tool.capability,
    connector: tool.connector,
    actionSlug: tool.actionSlug,
    plannerCard: tool.plannerCard,
  };
}
