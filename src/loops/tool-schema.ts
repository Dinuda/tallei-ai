export type SchemaFieldSummary = {
  required: string[];
  properties: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonEmpty(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
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

/**
 * Check whether args satisfy a JSON Schema `anyOf` clause.
 * At least one branch must have all its `required` fields present and non-empty.
 */
function checkAnyOf(
  args: Record<string, unknown>,
  anyOf: unknown,
): { ok: false; missing: string[]; required: string[] } | null {
  if (!Array.isArray(anyOf) || anyOf.length === 0) return null;
  const branches = anyOf.map((branch) => summarizeInputSchema(asRecord(branch) ?? {}));
  const satisfiedBranch = branches.find((branch) =>
    branch.required.length > 0 && branch.required.every((field) => isNonEmpty(args[field]))
  );
  // If any branch is satisfied, the constraint passes.
  if (satisfiedBranch) return null;
  // If all branches have required fields and none is satisfied, report the fields from all branches.
  const allBranchesHaveRequired = branches.every((b) => b.required.length > 0);
  if (!allBranchesHaveRequired) return null;
  const allRequired = [...new Set(branches.flatMap((b) => b.required))];
  const missing = allRequired.filter((field) => !isNonEmpty(args[field]));
  return missing.length > 0 ? { ok: false, missing, required: allRequired } : null;
}

/**
 * Check whether args satisfy a JSON Schema `oneOf` clause.
 * Exactly one branch must have all its `required` fields present and non-empty.
 */
function checkOneOf(
  args: Record<string, unknown>,
  oneOf: unknown,
): { ok: false; missing: string[]; required: string[] } | null {
  if (!Array.isArray(oneOf) || oneOf.length === 0) return null;
  const branches = oneOf.map((branch) => summarizeInputSchema(asRecord(branch) ?? {}));
  const satisfiedCount = branches.filter((branch) =>
    branch.required.length > 0 && branch.required.every((field) => isNonEmpty(args[field]))
  ).length;
  if (satisfiedCount === 1) return null;
  const allBranchesHaveRequired = branches.every((b) => b.required.length > 0);
  if (!allBranchesHaveRequired) return null;
  if (satisfiedCount === 0) {
    const allRequired = [...new Set(branches.flatMap((b) => b.required))];
    const missing = allRequired.filter((field) => !isNonEmpty(args[field]));
    return missing.length > 0 ? { ok: false, missing, required: allRequired } : null;
  }
  // satisfiedCount > 1: multiple branches satisfied — report all required fields as ambiguous.
  const allRequired = [...new Set(branches.flatMap((b) => b.required))];
  return { ok: false, missing: [], required: allRequired };
}

export function validateToolArgsAgainstSchema(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): { ok: true } | { ok: false; missing: string[]; required: string[] } {
  // 1. Top-level required fields.
  const summary = summarizeInputSchema(inputSchema);
  const missing = summary.required.filter((field) => !isNonEmpty(args[field]));
  if (missing.length > 0) return { ok: false, missing, required: summary.required };

  // 2. anyOf constraints (e.g. "at least one of add_label_ids or remove_label_ids").
  const row = asRecord(inputSchema) ?? {};
  const anyOfResult = checkAnyOf(args, row.anyOf);
  if (anyOfResult) return anyOfResult;

  // 3. oneOf constraints.
  const oneOfResult = checkOneOf(args, row.oneOf);
  if (oneOfResult) return oneOfResult;

  return { ok: true };
}
