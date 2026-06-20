import type { RunContext } from "./build-run-context.js";
import { renderArtifactTemplate } from "./render-artifact-template.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }
  return "";
}

function looksLikeGmailEmailAction(actionSlug: string): boolean {
  const slug = actionSlug.toUpperCase();
  return slug.includes("GMAIL")
    && (slug.includes("DRAFT") || slug.includes("REPLY") || slug.includes("SEND") || slug.includes("EMAIL"));
}

function normalizeGmailEmailPayload(
  payload: Record<string, unknown>,
  runContext?: RunContext,
): Record<string, unknown> {
  const next = { ...payload };

  const recipientEmail = firstString(
    next.recipient_email,
    next.to,
    next.recipient,
    next.email,
    runContext?.customer?.email,
  );
  if (recipientEmail) next.recipient_email = recipientEmail;

  const threadId = firstString(
    next.thread_id,
    next.threadId,
    runContext?.ticket?.threadId,
  );
  if (threadId) next.thread_id = threadId;

  const messageId = firstString(
    next.message_id,
    next.messageId,
    runContext?.ticket?.messageId,
  );
  if (messageId) next.message_id = messageId;

  delete next.to;
  delete next.recipient;
  delete next.email;
  delete next.threadId;
  delete next.messageId;

  return next;
}

export function enrichDraftPayload(
  actionSlug: string,
  payload: Record<string, unknown>,
  runContext?: RunContext,
): Record<string, unknown> {
  const slug = actionSlug.toUpperCase();
  const normalized = looksLikeGmailEmailAction(slug)
    ? normalizeGmailEmailPayload(payload, runContext)
    : payload;

  if (!runContext?.ticket) return normalized;
  if (!slug.includes("CREATE") || !slug.includes("DRAFT")) return normalized;

  const template = runContext.templates[0];
  const variables = {
    ticket_subject: runContext.ticket.subject,
    customer_name: runContext.customer?.name ?? runContext.customer?.email ?? "Customer",
  };
  const rendered = template
    ? renderArtifactTemplate(template, variables)
    : null;

  const next = { ...normalized };
  if (runContext.customer?.email && !next.recipient_email) {
    next.recipient_email = runContext.customer.email;
  }
  if (runContext.ticket.threadId && !next.thread_id) {
    next.thread_id = runContext.ticket.threadId;
  }
  if (rendered) {
    if (!next.subject) next.subject = rendered.subject;
    if (!next.body) next.body = rendered.body;
    if (!next.is_html) next.is_html = true;
  }
  return next;
}

export type DeferredWriteMeta = {
  toolkit: string;
  actionSlug: string;
  actionLabel: string;
  isSendAction: boolean;
};
