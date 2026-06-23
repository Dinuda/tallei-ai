export type NormalizedGetAvailableToolsInput = {
  outcome: string;
  cadence: string;
  approvalModel: string;
  toolCategories: string[];
  runtimeInputs: string[];
  resolvedIntent: string;
  selectedToolkits: string[];
  capabilityQueries: string[];
  assumptions: string[];
};

function normalizeSlugList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((entry) => entry.trim()).filter(Boolean);
}

/** Accept flat or legacy nested getAvailableTools payloads from the analyzer model. */
export function normalizeGetAvailableToolsInput(
  input: Record<string, unknown>,
  sessionGoal: string,
): NormalizedGetAvailableToolsInput {
  const nested = input.normalizedIntent && typeof input.normalizedIntent === "object"
    ? input.normalizedIntent as Record<string, unknown>
    : null;

  const outcome = String(
    input.outcome ?? nested?.outcome ?? input.resolvedIntent ?? sessionGoal,
  ).trim();
  const resolvedIntent = String(input.resolvedIntent ?? outcome ?? sessionGoal).trim();

  return {
    outcome: outcome || sessionGoal,
    cadence: String(input.cadence ?? nested?.cadence ?? "As needed"),
    approvalModel: String(
      input.approvalModel ?? nested?.approvalModel ?? "Operator approval before external mutations",
    ),
    toolCategories: normalizeStringList(input.toolCategories ?? nested?.toolCategories),
    runtimeInputs: normalizeStringList(input.runtimeInputs ?? nested?.runtimeInputs),
    resolvedIntent: resolvedIntent || sessionGoal,
    selectedToolkits: normalizeSlugList(input.selectedToolkits),
    capabilityQueries: normalizeStringList(input.capabilityQueries),
    assumptions: normalizeStringList(input.assumptions),
  };
}

export { tryParseJsonWithClosingBraces } from "../repair/tool-input-json-repair.js";

function collectAppSelectionSlugs(value: unknown, slugs: string[], seen: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectAppSelectionSlugs(entry, slugs, seen);
    return;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.selectedToolkits)) {
    for (const entry of record.selectedToolkits) {
      if (!entry || typeof entry !== "object") continue;
      const slug = String((entry as { slug?: unknown }).slug ?? "").trim().toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
  }

  for (const nested of Object.values(record)) {
    collectAppSelectionSlugs(nested, slugs, seen);
  }
}

export function extractAppSelectionSlugsFromUnknown(value: unknown): string[] {
  const slugs: string[] = [];
  collectAppSelectionSlugs(value, slugs, new Set());
  return slugs;
}
