import type { LoopContactRow } from "../loop-executor/types.js";
import type { RuntimeContext } from "./types.js";

export type RecipientSourceKind = "none" | "configured" | "uploaded" | "operator_input";
export type RecipientStatus = "missing" | "ready";

export type DeliveryRecipients = NonNullable<RuntimeContext["deliveryRecipients"]>;

const RECIPIENT_ERROR_PATTERN = /requires at least one recipient|requires audience_id|segment_id|list_id/i;

export function isMissingRecipientError(message: string): boolean {
  return RECIPIENT_ERROR_PATTERN.test(message);
}

export function recipientSourceRequiresOperatorInput(kind: RecipientSourceKind): boolean {
  return kind === "uploaded" || kind === "operator_input";
}

function readConfiguredAudienceId(config: Record<string, unknown>): string {
  for (const key of ["audience_id", "segment_id", "list_id", "audienceId", "segmentId", "listId"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function resolveRecipientStatus(input: {
  recipientSource: { kind: RecipientSourceKind };
  context: RuntimeContext;
  assignmentConfig?: Record<string, unknown>;
}): RecipientStatus {
  const configuredAudienceId = readConfiguredAudienceId(input.assignmentConfig ?? {});
  const contextAudienceId = input.context.deliveryRecipients?.audienceId?.trim() ?? "";
  if (input.recipientSource.kind === "configured" && (configuredAudienceId || contextAudienceId)) return "ready";
  const count = input.context.deliveryRecipients?.recipientCount ?? input.context.deliveryRecipients?.contacts.length ?? 0;
  return count > 0 ? "ready" : "missing";
}

export function buildDeliveryRecipientsPatch(input: {
  contacts: LoopContactRow[];
  source: RecipientSourceKind;
  audienceId?: string;
  documentRef?: string;
  lotRef?: string;
}): DeliveryRecipients {
  const recipientCount = input.contacts.length > 0
    ? input.contacts.length
    : input.audienceId?.trim()
      ? 1
      : 0;
  return {
    uploadedAt: new Date().toISOString(),
    contacts: input.contacts,
    recipientCount,
    source: input.source === "none" ? undefined : input.source,
    ...(input.audienceId ? { audienceId: input.audienceId } : {}),
    ...(input.documentRef ? { documentRef: input.documentRef } : {}),
    ...(input.lotRef ? { lotRef: input.lotRef } : {}),
  };
}

export function recipientEmailsFromContext(context: RuntimeContext): string[] {
  return (context.deliveryRecipients?.contacts ?? []).map((contact) => contact.email);
}

export function injectDeliveryRecipientsIntoPayload(input: {
  payload: Record<string, unknown>;
  context: RuntimeContext;
  actionSlug: string;
  assignmentConfig?: Record<string, unknown>;
}): Record<string, unknown> {
  const next = { ...input.payload };
  const emails = recipientEmailsFromContext(input.context);
  const slug = input.actionSlug.toLowerCase();
  const configuredAudienceId = readConfiguredAudienceId(input.assignmentConfig ?? {});
  const contextAudienceId = input.context.deliveryRecipients?.audienceId?.trim() ?? "";

  if (slug.includes("broadcast")) {
    const audienceId = configuredAudienceId || contextAudienceId;
    if (audienceId) {
      next.audience_id = audienceId;
      next.segment_id = audienceId;
      next.list_id = audienceId;
    }
    return next;
  }

  if (emails.length > 0) {
    next.to = emails;
    next.recipients = emails;
    next.emails = emails;
    next.subscriber_emails = emails;
  }
  return next;
}

export function contactsFromDecision(decision: Record<string, unknown>): LoopContactRow[] {
  if (!Array.isArray(decision.contacts)) return [];
  const contacts: LoopContactRow[] = [];
  for (const row of decision.contacts) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const email = typeof item.email === "string"
      ? item.email.trim()
      : "";
    if (!email.includes("@")) continue;
    const name = typeof item.name === "string"
      ? item.name.trim()
      : undefined;
    contacts.push({ email, ...(name ? { name } : {}) });
  }
  return contacts;
}
