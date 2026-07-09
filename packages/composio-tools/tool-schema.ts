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

/** Stable catalog tool id from the exact Composio action slug. */
export function toolIdForAction(actionSlug: string): string {
  return `tool_${actionSlug.trim().toLowerCase()}`;
}

/** Capability label on a bound tool is the Composio action slug — no semantic aliases. */
export function capabilityForAction(actionSlug: string): string {
  return actionSlug.trim().toUpperCase();
}

const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "that", "this", "into", "when", "each", "agent", "loop",
]);

function outcomeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

/** Lowercase text built from schema field names and their descriptions. */
export function schemaFieldText(inputSchema: Record<string, unknown>): string {
  const summary = summarizeInputSchema(inputSchema);
  const row = asRecord(inputSchema) ?? {};
  const properties = asRecord(row.properties) ?? {};
  const parts = [...summary.required, ...summary.properties];
  for (const field of summary.properties) {
    const prop = asRecord(properties[field]);
    if (typeof prop?.description === "string") parts.push(prop.description);
  }
  return parts.join(" ").toLowerCase();
}

/** Score overlap between an outcome description and a tool's schema field names/descriptions. */
export function scoreSchemaFieldRelevance(
  outcomeDescription: string,
  inputSchema: Record<string, unknown>,
): number {
  const haystack = schemaFieldText(inputSchema);
  return outcomeWords(outcomeDescription).reduce(
    (score, word) => (haystack.includes(word) ? score + 1 : score),
    0,
  );
}

/** Score how many trigger payload keys appear in the tool input schema. */
export function scoreTriggerFieldOverlap(
  triggerFields: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): number {
  const schemaFields = new Set(
    [...summarizeInputSchema(inputSchema).required, ...summarizeInputSchema(inputSchema).properties]
      .map((field) => field.toLowerCase()),
  );
  return Object.entries(triggerFields).filter(([key, value]) =>
    isNonEmpty(value) && schemaFields.has(key.toLowerCase()),
  ).length;
}

/** Keep only args that appear in the schema properties (runner may add required fields separately). */
export function filterArgsToSchemaProperties(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(summarizeInputSchema(inputSchema).properties);
  return Object.fromEntries(Object.entries(args).filter(([key]) => allowed.has(key)));
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
    branch.required.length > 0 && branch.required.every((field) => isNonEmpty(args[field])),
  );
  if (satisfiedBranch) return null;
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
    branch.required.length > 0 && branch.required.every((field) => isNonEmpty(args[field])),
  ).length;
  if (satisfiedCount === 1) return null;
  const allBranchesHaveRequired = branches.every((b) => b.required.length > 0);
  if (!allBranchesHaveRequired) return null;
  if (satisfiedCount === 0) {
    const allRequired = [...new Set(branches.flatMap((b) => b.required))];
    const missing = allRequired.filter((field) => !isNonEmpty(args[field]));
    return missing.length > 0 ? { ok: false, missing, required: allRequired } : null;
  }
  const allRequired = [...new Set(branches.flatMap((b) => b.required))];
  return { ok: false, missing: [], required: allRequired };
}

export function validateToolArgsAgainstSchema(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): { ok: true } | { ok: false; missing: string[]; required: string[] } {
  const summary = summarizeInputSchema(inputSchema);
  const missing = summary.required.filter((field) => !isNonEmpty(args[field]));
  if (missing.length > 0) return { ok: false, missing, required: summary.required };

  const row = asRecord(inputSchema) ?? {};
  const anyOfResult = checkAnyOf(args, row.anyOf);
  if (anyOfResult) return anyOfResult;

  const oneOfResult = checkOneOf(args, row.oneOf);
  if (oneOfResult) return oneOfResult;

  return { ok: true };
}
