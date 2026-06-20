import {
  normalizeConnectorPayloadForSchema,
} from "../loop-runtime/connector-action-payload.js";
import type { ToolContract } from "../tool-spec/types.js";
import type { VerificationTarget } from "./verification-scope.js";

type VerificationProbeContext = {
  verificationId: string;
  definition?: { goal?: string } | null;
  chainState: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeSlug(slug: string): string {
  return slug.replace(/-/g, "_").toUpperCase();
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return asObject(schema.properties);
}

function schemaRequired(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function pickArtifactEmail(definition?: { goal?: string } | null): { subject: string; body: string } {
  const subject = definition?.goal?.trim();
  return {
    subject: subject || "[Tallei verify] Dry-run probe",
    body: subject || "This is an automated verification message from Tallei. No action is required.",
  };
}

function fillDefaultForProperty(key: string, propSchema: Record<string, unknown>, context: VerificationProbeContext): unknown {
  const lowerKey = key.toLowerCase();
  const propType = typeof propSchema.type === "string" ? propSchema.type : null;
  const email = pickArtifactEmail(context.definition);

  if (lowerKey.includes("draft") && lowerKey.includes("id")) {
    const draftId = context.chainState.createdDraftId;
    if (typeof draftId === "string" && draftId.trim()) return draftId;
  }
  if (lowerKey === "id" && typeof context.chainState.createdDraftId === "string") {
    return context.chainState.createdDraftId;
  }
  if (lowerKey.includes("subject") || lowerKey === "title") return email.subject;
  if (lowerKey.includes("body") || lowerKey.includes("content") || lowerKey.includes("message") || lowerKey === "html") {
    return email.body;
  }
  if (lowerKey.includes("to") || lowerKey.includes("recipient") || lowerKey.includes("email")) {
    return "verifier@test.local";
  }
  if (lowerKey.includes("query") || lowerKey.includes("search")) return "test";
  if (lowerKey.includes("max") && lowerKey.includes("result")) return 1;
  if (lowerKey.includes("limit")) return 1;
  if (lowerKey.includes("page") || lowerKey.includes("offset")) return 0;

  if (propType === "string") return "test";
  if (propType === "integer" || propType === "number") return 1;
  if (propType === "boolean") return false;
  if (propType === "array") return [];
  if (propType === "object") return {};
  return "test";
}

export function buildProbePayload(
  contract: ToolContract,
  target: VerificationTarget,
  context: VerificationProbeContext,
): Record<string, unknown> {
  const slug = normalizeSlug(target.actionSlug);
  const schema = contract.inputSchema;
  const properties = schemaProperties(schema);
  const required = schemaRequired(schema);
  const payload: Record<string, unknown> = {};

  for (const key of required) {
    const propSchema = asObject(properties[key]);
    payload[key] = fillDefaultForProperty(key, propSchema, context);
  }

  if (slug.includes("CREATE") && (slug.includes("DRAFT") || slug.includes("EMAIL"))) {
    const email = pickArtifactEmail(context.definition);
    for (const [key, propSchema] of Object.entries(properties)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("subject")) payload[key] = email.subject;
      if (lowerKey.includes("body") || lowerKey.includes("content") || lowerKey.includes("message") || lowerKey === "html") {
        payload[key] = email.body;
      }
      if (lowerKey.includes("to") || lowerKey.includes("recipient")) payload[key] = "verifier@test.local";
    }
  }

  if (slug.includes("SEND") && slug.includes("DRAFT") && typeof context.chainState.createdDraftId === "string") {
    for (const key of Object.keys(properties)) {
      if (key.toLowerCase().includes("draft") || key.toLowerCase() === "id") {
        payload[key] = context.chainState.createdDraftId;
      }
    }
  }

  if (slug.includes("LIST") && slug.includes("DRAFT")) {
    for (const key of Object.keys(properties)) {
      if (key.toLowerCase().includes("max") || key.toLowerCase().includes("limit")) payload[key] = 1;
    }
  }

  if (slug.includes("CONTACT") || slug.includes("PEOPLE") || slug.includes("SEARCH")) {
    for (const key of Object.keys(properties)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("query") || lowerKey.includes("search")) payload[key] = "test";
      if (lowerKey.includes("max") || lowerKey.includes("limit")) payload[key] = 1;
    }
  }

  return normalizeConnectorPayloadForSchema(payload, schema);
}

export function extractProbeChainState(
  target: VerificationTarget,
  output: unknown,
): Record<string, unknown> {
  const slug = normalizeSlug(target.actionSlug);
  if (!slug.includes("CREATE") || !(slug.includes("DRAFT") || slug.includes("EMAIL"))) return {};

  const rows = [asObject(output), asObject(asObject(output).data), asObject(asObject(output).result)];
  for (const row of rows) {
    const candidates = [
      row.id,
      row.draft_id,
      row.draftId,
      asObject(row.draft).id,
      asObject(row.message).id,
    ];
    const match = candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (match) return { createdDraftId: match };
  }
  return {};
}

export function summarizeProbePayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  if (keys.length === 0) return "empty payload";
  return keys.map((key) => {
    const value = payload[key];
    if (typeof value === "string" && value.length > 80) return `${key}: ${value.slice(0, 77)}...`;
    return `${key}: ${JSON.stringify(value)}`;
  }).join(", ");
}
