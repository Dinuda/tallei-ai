import { RUNTIME_EMAIL_MESSAGE_LIMIT } from "./tool-result-compact.js";
import { summarizeInputSchema } from "@tallei/composio-tools/tool-schema.js";

const LIMIT_FIELD_MARKERS = ["maxresults", "limit", "pagesize"];
const PAYLOAD_FIELD_MARKERS = ["includepayload", "includebody", "fullpayload"];

function normalizedFieldName(field: string): string {
  return field.toLowerCase().replace(/_/g, "");
}

function fieldMatchesMarkers(field: string, markers: string[]): boolean {
  const norm = normalizedFieldName(field);
  return markers.some((marker) => norm.includes(marker));
}

function clampLimitValue(value: unknown, max: number): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(1, value), max);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return String(Math.min(Math.max(1, Number(value)), max));
  }
  return max;
}

function schemaHasListShape(summary: ReturnType<typeof summarizeInputSchema>): boolean {
  const fields = [...summary.required, ...summary.properties].map(normalizedFieldName);
  const hasLimit = fields.some((field) => LIMIT_FIELD_MARKERS.some((marker) => field.includes(marker)));
  if (!hasLimit) return false;
  return fields.some((field) =>
    field.includes("query") || field.includes("search") || field.includes("filter") || field.includes("q"),
  );
}

/**
 * Tighten Composio args before loop runtime execution using only the fetched input schema:
 * - list-shaped schemas (query + limit fields): cap limit fields
 * - schemas with payload/body include fields: disable them
 */
export function clampComposioArgsForRuntime(input: {
  inputSchema: Record<string, unknown>;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const args = { ...input.args };
  const summary = summarizeInputSchema(input.inputSchema);
  const fields = [...new Set([...summary.required, ...summary.properties])];

  if (schemaHasListShape(summary)) {
    let hasLimitField = false;
    for (const field of fields) {
      if (!fieldMatchesMarkers(field, LIMIT_FIELD_MARKERS)) continue;
      hasLimitField = true;
      args[field] = clampLimitValue(args[field], RUNTIME_EMAIL_MESSAGE_LIMIT);
    }
    if (!hasLimitField) {
      const limitField = fields.find((field) => fieldMatchesMarkers(field, LIMIT_FIELD_MARKERS));
      if (limitField) args[limitField] = RUNTIME_EMAIL_MESSAGE_LIMIT;
    }
  }

  for (const field of fields) {
    if (fieldMatchesMarkers(field, PAYLOAD_FIELD_MARKERS)) {
      args[field] = false;
    }
  }

  return args;
}
