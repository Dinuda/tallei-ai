import type { RunContext } from "./build-run-context.js";
import { stripToSchema } from "../loop-engine/data-contract.js";
import {
  normalizeConnectorPayloadForSchema,
  validateConnectorActionPayload,
} from "./connector-action-payload.js";
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

function looksLikeGmailAction(actionSlug: string): boolean {
  return actionSlug.toUpperCase().includes("GMAIL");
}

function normalizeGmailPayload(
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

  const body = firstString(next.body, next.message, next.text);
  if (body) next.body = body;

  const messageId = firstString(
    next.message_id,
    next.messageId,
    runContext?.ticket?.messageId,
  );
  if (messageId) next.message_id = messageId;

  delete next.to;
  delete next.recipient;
  delete next.email;
  delete next.message;
  delete next.text;
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
  const normalized = looksLikeGmailAction(slug)
    ? normalizeGmailPayload(payload, runContext)
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

function formatValidationErrors(
  errors: ReturnType<typeof validateConnectorActionPayload>["errors"],
): string {
  return errors
    .map((error) => `${error.path}: ${error.message}`)
    .join("; ");
}

/** Strip, normalize, enrich from run context, and validate before Composio execution. */
export function prepareConnectorActionPayload(input: {
  actionSlug: string;
  inputSchema: Record<string, unknown>;
  payload: Record<string, unknown>;
  runContext?: RunContext;
  resolvedHandoff?: Record<string, unknown>;
}): Record<string, unknown> {
  const boundPayload = {
    ...input.payload,
    ...(input.resolvedHandoff ?? {}),
  };
  const aliasedPayload = enrichDraftPayload(
    input.actionSlug,
    boundPayload,
    input.runContext,
  );
  const strippedPayload = stripToSchema(
    input.inputSchema,
    aliasedPayload,
  ) as Record<string, unknown>;
  const normalizedPayload = normalizeConnectorPayloadForSchema(
    strippedPayload,
    input.inputSchema,
  );
  const enriched = enrichDraftPayload(
    input.actionSlug,
    normalizedPayload,
    input.runContext,
  );
  const finalPayload = stripToSchema(
    input.inputSchema,
    enriched,
  ) as Record<string, unknown>;
  const validation = validateConnectorActionPayload(
    { inputSchema: input.inputSchema },
    finalPayload,
  );
  if (!validation.valid) {
    throw new Error(
      `Connector payload failed schema validation: ${formatValidationErrors(validation.errors)}`,
    );
  }
  return finalPayload;
}

export type DeferredWriteMeta = {
  toolkit: string;
  actionSlug: string;
  actionLabel: string;
  isSendAction: boolean;
};
