import type { ComposioActionInstruction, ToolPlannerCard } from "./contract-types.js";
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

/**
 * Extract anyOf/oneOf field groups from the schema and annotate arg descriptions
 * so the planner knows which fields are conditionally required together.
 */
function conditionalRequirementNotes(inputSchema: Record<string, unknown>): Map<string, string> {
  const notes = new Map<string, string>();
  const row = asRecord(inputSchema) ?? {};

  function processGroup(group: unknown, label: string): void {
    if (!Array.isArray(group)) return;
    const branchFields = group.map((branch) => {
      const b = asRecord(branch) ?? {};
      const req = Array.isArray(b.required) ? b.required.filter((f): f is string => typeof f === "string") : [];
      return req;
    }).filter((req) => req.length > 0);
    if (branchFields.length < 2) return;
    const allFields = [...new Set(branchFields.flat())];
    const groupDescription = `${label}: ${branchFields.map((fields) => fields.join(" + ")).join(" OR ")}`;
    for (const field of allFields) {
      const existing = notes.get(field);
      notes.set(field, existing ? `${existing}; ${groupDescription}` : groupDescription);
    }
  }

  processGroup(row.anyOf, "At least one required");
  processGroup(row.oneOf, "Exactly one required");
  return notes;
}

function buildArgGuides(inputSchema: Record<string, unknown>): ToolPlannerCard["argGuides"] {
  const row = asRecord(inputSchema) ?? {};
  const properties = asRecord(row.properties) ?? row;
  const guides: ToolPlannerCard["argGuides"] = {};
  const conditionalNotes = conditionalRequirementNotes(inputSchema);

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
    const conditionalNote = conditionalNotes.get(field);

    const fullDescription = [description, conditionalNote].filter(Boolean).join(" — ");
    if (fullDescription || examples?.length || constraints) {
      guides[field] = {
        ...(fullDescription ? { description: fullDescription } : {}),
        ...(examples?.length ? { examples } : {}),
        ...(constraints ? { constraints } : {}),
      };
    }
  }
  return guides;
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
  const argGuides = buildArgGuides(input.inputSchema);
  const antiPatterns = (input.pitfalls ?? []).slice(0, 4);

  return {
    summary: input.description || input.actionSlug,
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
  composioAction?: ComposioActionInstruction;
  modifiedInputSchema?: Record<string, unknown>;
  behaviorInstructions?: string[];
}): Record<string, unknown> {
  const visibleFields = tool.modifiedInputSchema
    ? new Set(summarizeInputSchema(tool.modifiedInputSchema).properties)
    : null;
  const plannerCard = visibleFields
    ? {
        ...tool.plannerCard,
        argGuides: Object.fromEntries(
          Object.entries(tool.plannerCard.argGuides).filter(([field]) => visibleFields.has(field)),
        ),
      }
    : tool.plannerCard;
  return {
    id: tool.id,
    capability: tool.capability,
    connector: tool.connector,
    actionSlug: tool.actionSlug,
    ...(tool.modifiedInputSchema ? { modifiedInputSchema: tool.modifiedInputSchema } : {}),
    ...(tool.behaviorInstructions?.length ? { behaviorInstructions: tool.behaviorInstructions } : {}),
    ...(tool.composioAction ? { composioAction: tool.composioAction } : {}),
    plannerCard,
  };
}
