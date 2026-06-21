import type { RunContext } from "./build-run-context.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Fill evidence gaps from authoritative trigger context before persisting handoff. */
export function enrichEvidenceStructuredOutput(
  runContext: RunContext,
  output: unknown,
): Record<string, unknown> {
  const next = { ...asRecord(output) };

  if (runContext.ticket) {
    const ticket = asRecord(next.ticket);
    next.ticket = {
      subject: readString(ticket.subject) || runContext.ticket.subject,
      body: readString(ticket.body) || runContext.ticket.body,
      ...(runContext.ticket.threadId ? { threadId: runContext.ticket.threadId } : {}),
      ...(runContext.ticket.messageId ? { messageId: runContext.ticket.messageId } : {}),
    };
  }

  if (runContext.customer) {
    const customer = asRecord(next.customer);
    next.customer = {
      ...(runContext.customer.name || readString(customer.name)
        ? { name: readString(customer.name) || runContext.customer.name }
        : {}),
      ...(runContext.customer.email || readString(customer.email)
        ? { email: readString(customer.email) || runContext.customer.email }
        : {}),
    };
  }

  const context = asRecord(next.context);
  if (!readString(next.priority)) {
    const fromContext = readString(context.priority);
    if (fromContext) next.priority = fromContext;
  }

  return next;
}

/** Merge trigger context into resolved handoff when upstream evidence is summary-only. */
export function enrichResolvedHandoffValue(
  runContext: RunContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const enriched = enrichEvidenceStructuredOutput(runContext, value);
  if (!readString(enriched.summary) && readString(asRecord(value).summary)) {
    enriched.summary = readString(asRecord(value).summary);
  }
  return enriched;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
