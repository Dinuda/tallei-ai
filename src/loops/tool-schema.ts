export type SchemaFieldSummary = {
  required: string[];
  properties: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function summarizeInputSchema(inputSchema: Record<string, unknown>): SchemaFieldSummary {
  const row = asRecord(inputSchema) ?? {};
  const properties = asRecord(row.properties) ?? row;
  const required = Array.isArray(row.required)
    ? row.required.filter((field): field is string => typeof field === "string")
    : [];
  const propertyNames = Object.keys(properties).filter((key) => key !== "required" && key !== "type");
  return {
    required,
    properties: propertyNames,
  };
}

const LIST_ARG_HINTS = ["query", "q", "search", "filter", "maxresults", "max_results", "limit", "page_size", "pagesize"];

function fieldLooksLikeId(field: string): boolean {
  const normalized = field.toLowerCase();
  return normalized === "id" || normalized.endsWith("_id") || normalized.endsWith("id");
}

function schemaSupportsCollectionFetch(summary: SchemaFieldSummary): boolean {
  const fields = [...summary.required, ...summary.properties].map((field) => field.toLowerCase());
  return fields.some((field) => LIST_ARG_HINTS.some((hint) => field.includes(hint.replace("_", ""))));
}

function schemaRequiresOnlyIds(summary: SchemaFieldSummary): boolean {
  if (summary.required.length === 0) return false;
  return summary.required.every((field) => fieldLooksLikeId(field)) && !schemaSupportsCollectionFetch(summary);
}

/** Map a resolved Composio action to a semantic capability that passes compile-time schema fit. */
export function semanticCapabilityForAction(
  actionSlug: string,
  inputSchema: Record<string, unknown>,
  domain = "tool",
): string {
  const slug = actionSlug.toUpperCase();
  const summary = summarizeInputSchema(inputSchema);

  if (slug.includes("DRAFT")) return `${domain}.draft`;
  if (slug.includes("SEND") || slug.includes("REPLY")) return `${domain}.send`;
  if (slug.includes("LABEL") || slug.includes("TAG") || slug.includes("CATEGOR")) return `${domain}.labels`;
  if (schemaRequiresOnlyIds(summary) || slug.includes("MESSAGE_ID") || slug.includes("BY_ID")) {
    return `${domain}.get`;
  }
  if (slug.includes("LIST") || slug.includes("SEARCH") || slug.includes("QUERY") || slug.includes("FILTER")) {
    return `${domain}.read`;
  }
  if (slug.includes("FETCH") || slug.includes("READ") || slug.includes("GET")) return `${domain}.read`;
  return `${domain}.action`;
}

/** Score how well a Composio input schema matches an outcome capability label (no provider tables). */
export function scoreSchemaFitForCapability(
  capability: string,
  inputSchema: Record<string, unknown>,
  actionSlug?: string,
): number {
  const summary = summarizeInputSchema(inputSchema);
  let cap = capability.toLowerCase();

  // Raw Composio slugs are not semantic capabilities — infer fit from the action instead.
  if (/^[a-z][a-z0-9_]+$/.test(cap) && cap.includes("_") && actionSlug) {
    const domain = cap.split("_")[0] ?? "tool";
    cap = semanticCapabilityForAction(actionSlug, inputSchema, domain).toLowerCase();
  }

  const pollIntent = /(?:^|[._])(?:read|list|fetch|search|query|find|receive|incoming)(?:[._]|$)/.test(cap);
  const singleItemIntent = /(?:^|[._])(?:get|by_id|byid)(?:[._]|$)/.test(cap);

  if (pollIntent && schemaRequiresOnlyIds(summary)) return -8;
  if (pollIntent && schemaSupportsCollectionFetch(summary)) return 6;
  if (singleItemIntent && summary.required.some((field) => fieldLooksLikeId(field))) return 4;
  return 0;
}

export function validateToolArgsAgainstSchema(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): { ok: true } | { ok: false; missing: string[]; required: string[] } {
  const summary = summarizeInputSchema(inputSchema);
  const missing = summary.required.filter((field) => {
    const value = args[field];
    return value === undefined || value === null || value === "";
  });
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, required: summary.required };
}

export function summarizeToolForPlanner(tool: {
  id: string;
  capability: string;
  connector: string;
  actionSlug: string;
  inputSchema: Record<string, unknown>;
}): Record<string, unknown> {
  const schema = summarizeInputSchema(tool.inputSchema);
  return {
    id: tool.id,
    capability: tool.capability,
    connector: tool.connector,
    actionSlug: tool.actionSlug,
    requiredFields: schema.required,
    optionalFields: schema.properties.filter((field) => !schema.required.includes(field)),
  };
}
