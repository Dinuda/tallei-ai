import { RUNTIME_EMAIL_MESSAGE_LIMIT } from "./tool-result-compact.js";
import { summarizeInputSchema } from "./tool-schema.js";

const LIST_LIMIT_FIELDS = ["max_results", "maxresults", "max_results_per_page", "limit", "page_size", "pagesize"];
const PAYLOAD_FIELDS = ["include_payload", "includepayload", "include_body", "includebody", "full_payload"];

function fieldMatchesAny(field: string, hints: string[]): boolean {
  const norm = field.toLowerCase().replace(/_/g, "");
  return hints.some((hint) => norm.includes(hint.replace(/_/g, "")));
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

/** List/search Gmail reads (not single-message get-by-id). */
export function isEmailListAction(actionSlug: string, capability: string): boolean {
  if (capability === "email.read") return true;
  const slug = actionSlug.toUpperCase();
  if (!slug.startsWith("GMAIL_")) return false;
  if (slug.includes("MESSAGE_ID") || slug.includes("BY_ID") || slug.includes("BY_THREAD")) return false;
  return slug.includes("FETCH") || slug.includes("LIST") || slug.includes("SEARCH");
}

/** Single-message Gmail fetch (get-by-id / thread). */
export function isEmailGetAction(actionSlug: string, capability: string): boolean {
  if (capability === "email.get") return true;
  const slug = actionSlug.toUpperCase();
  if (!slug.startsWith("GMAIL_")) return false;
  return slug.includes("MESSAGE_ID") || slug.includes("BY_ID") || slug.includes("BY_THREAD");
}

/**
 * Tighten Composio args before loop runtime execution:
 * - email.read: cap list limits to latest N messages
 * - email.read/get: disable full MIME payloads (metadata + snippet only)
 */
export function clampComposioArgsForRuntime(input: {
  actionSlug: string;
  capability: string;
  inputSchema: Record<string, unknown>;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const args = { ...input.args };
  const isList = isEmailListAction(input.actionSlug, input.capability);
  const isGet = isEmailGetAction(input.actionSlug, input.capability);
  if (!isList && !isGet) return args;

  const schema = summarizeInputSchema(input.inputSchema);
  const fields = [...new Set([...schema.required, ...schema.properties])];

  if (isList) {
    let hasLimitField = false;
    for (const field of fields) {
      if (!fieldMatchesAny(field, LIST_LIMIT_FIELDS)) continue;
      hasLimitField = true;
      const next = clampLimitValue(args[field], RUNTIME_EMAIL_MESSAGE_LIMIT);
      args[field] = next;
    }
    if (!hasLimitField) {
      const limitField = fields.find((field) => fieldMatchesAny(field, LIST_LIMIT_FIELDS));
      if (limitField) args[limitField] = RUNTIME_EMAIL_MESSAGE_LIMIT;
      else args.max_results = RUNTIME_EMAIL_MESSAGE_LIMIT;
    }
  }

  for (const field of fields) {
    if (fieldMatchesAny(field, PAYLOAD_FIELDS)) {
      args[field] = false;
    }
  }
  for (const field of PAYLOAD_FIELDS) {
    if (field in args) args[field] = false;
  }

  return args;
}
