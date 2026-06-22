import {
  selectedArtifactContract,
  selectedConnectorAccountId,
  selectedConnectorActionSlugs,
  selectedGroundingSources,
  selectedLoopTrigger,
  selectedReviewPolicy,
  selectedStableInputs,
  type GroundingSourceRef,
  type ReviewPolicyMode,
} from "../loop-engine/build-contract.js";
import type { SpecRunTrigger } from "./spec-runner.js";
import type { SpecRunDefinition } from "./spec-run-types.js";
import { resolveBuildContract } from "./definition-hydration.js";
import type { StoredTriggerPayload } from "./trigger-payload.js";
import { normalizeGmailTriggerPayload } from "./trigger-normalizers/gmail.js";

export type RunContextTicket = {
  subject: string;
  body: string;
  messageId?: string;
  threadId?: string;
};

export type RunContextCustomer = {
  name?: string;
  email?: string;
};

export type RunnableArtifactTemplate = {
  id: string;
  name: string;
  templateId: string;
  subject: string;
  html: string;
  text?: string;
};

export type RunContext = {
  workflowId: string;
  trigger: {
    source: SpecRunTrigger["source"];
    slug?: string;
    label?: string;
    toolkit?: string;
  };
  ticket?: RunContextTicket;
  customer?: RunContextCustomer;
  policies: {
    ticketContentMode: string;
    customerDetailsMode: string;
    reviewMode: ReviewPolicyMode | null;
  };
  grounding: GroundingSourceRef[];
  templates: RunnableArtifactTemplate[];
  connectorActionSlugs: string[];
  connectorAccountIds: Record<string, string>;
  hasTriggerPayload: boolean;
};

function applyTicketContentMode(ticket: RunContextTicket, mode: string): RunContextTicket {
  if (mode === "subject_and_body" || mode === "subject + body") {
    const combined = [ticket.subject, ticket.body].filter(Boolean).join("\n\n").trim();
    return { ...ticket, body: combined || ticket.body };
  }
  if (mode === "trimmed_body" || mode === "trimmed body") {
    const trimmed = stripQuotedReplyHistory(ticket.body);
    return { ...ticket, body: trimmed || ticket.body };
  }
  return ticket;
}

function stripQuotedReplyHistory(body: string): string {
  const lines = body.split("\n");
  const cutPatterns = [
    /^On .+ wrote:$/i,
    /^-{2,}\s*Original Message\s*-{2,}$/i,
    /^From:\s/i,
    /^>{1,}\s/,
  ];
  const kept: string[] = [];
  for (const line of lines) {
    if (cutPatterns.some((pattern) => pattern.test(line.trim()))) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function ticketFromTriggerPayload(
  triggerSlug: string,
  data: Record<string, unknown>,
  stableInputs: Record<string, string>,
): { ticket?: RunContextTicket; customer?: RunContextCustomer } {
  const ticketContentMode = stableInputs.ticket_content ?? "email_body";
  const customerMode = stableInputs.customer_details ?? "sender_name_email";

  if (triggerSlug === "GMAIL_NEW_GMAIL_MESSAGE" || triggerSlug.includes("GMAIL")) {
    const normalized = normalizeGmailTriggerPayload(data);
    if (!normalized) return {};
    let ticket: RunContextTicket = {
      subject: normalized.subject,
      body: normalized.body,
      messageId: normalized.messageId || undefined,
      threadId: normalized.threadId || undefined,
    };
    ticket = applyTicketContentMode(ticket, ticketContentMode);

    const customer: RunContextCustomer = {};
    if (customerMode === "sender_name_email" || customerMode.includes("sender")) {
      customer.name = normalized.fromName || undefined;
      customer.email = normalized.fromEmail || undefined;
    }
    return { ticket, customer };
  }

  const subject = typeof data.subject === "string" ? data.subject : "";
  const body = typeof data.body === "string" ? data.body : typeof data.message === "string" ? data.message : "";
  if (!subject && !body) return {};
  let ticket: RunContextTicket = { subject, body };
  ticket = applyTicketContentMode(ticket, ticketContentMode);
  return { ticket };
}

export function projectRunContext(input: {
  spec: SpecRunDefinition;
  workflowId: string;
  trigger: SpecRunTrigger;
  triggerPayload?: StoredTriggerPayload | null;
}): RunContext {
  const definition = input.spec;
  const contract = resolveBuildContract(definition);
  const stableInputs = contract ? selectedStableInputs(contract) : {};
  const loopTrigger = contract ? selectedLoopTrigger(contract) : null;
  const artifacts = contract ? selectedArtifactContract(contract) : null;
  const connectorSlugs = contract ? selectedConnectorActionSlugs(contract) : [];

  const toolkits = new Set<string>();
  if (loopTrigger?.mode === "event") toolkits.add(loopTrigger.toolkit);
  for (const slug of connectorSlugs) {
    if (slug.toLowerCase().includes("gmail")) toolkits.add("gmail");
  }

  const connectorAccountIds: Record<string, string> = {};
  if (contract) {
    for (const toolkit of toolkits) {
      const accountId = selectedConnectorAccountId(contract, toolkit);
      if (accountId) connectorAccountIds[toolkit] = accountId;
    }
  }

  let ticket: RunContextTicket | undefined;
  let customer: RunContextCustomer | undefined;
  const triggerSlug = input.trigger.triggerSlug
    ?? input.triggerPayload?.triggerSlug
    ?? (loopTrigger?.mode === "event" ? loopTrigger.triggerSlug : undefined);
  if (input.triggerPayload && triggerSlug) {
    const resolved = ticketFromTriggerPayload(triggerSlug, input.triggerPayload.data, stableInputs);
    ticket = resolved.ticket;
    customer = resolved.customer;
  }

  return {
    workflowId: input.workflowId,
    trigger: {
      source: input.trigger.source,
      slug: triggerSlug,
      label: input.trigger.label,
      toolkit: loopTrigger?.mode === "event" ? loopTrigger.toolkit : undefined,
    },
    ticket,
    customer,
    policies: {
      ticketContentMode: stableInputs.ticket_content ?? "email_body",
      customerDetailsMode: stableInputs.customer_details ?? "sender_name_email",
      reviewMode: contract ? selectedReviewPolicy(contract) : null,
    },
    grounding: contract ? selectedGroundingSources(contract) : [],
    templates: artifacts?.templates ?? [],
    connectorActionSlugs: connectorSlugs,
    connectorAccountIds,
    hasTriggerPayload: Boolean(ticket),
  };
}

export function buildRunSeedMessage(runContext: RunContext, spec: SpecRunDefinition): string {
  const definition = spec;
  if (runContext.hasTriggerPayload && runContext.ticket) {
    const lines = [
      `Event: ${runContext.trigger.slug ?? runContext.trigger.label ?? "connector event"}`,
      "",
      `Ticket (ticket_content=${runContext.policies.ticketContentMode}):`,
      `- Subject: ${runContext.ticket.subject || "(no subject)"}`,
      `- Body: ${runContext.ticket.body || "(empty body)"}`,
    ];
    if (runContext.ticket.threadId) lines.push(`- Thread ID: ${runContext.ticket.threadId}`);
    if (runContext.ticket.messageId) lines.push(`- Message ID: ${runContext.ticket.messageId}`);
    lines.push("");
    lines.push(`Customer (customer_details=${runContext.policies.customerDetailsMode}):`);
    if (runContext.customer?.name) lines.push(`- Name: ${runContext.customer.name}`);
    if (runContext.customer?.email) lines.push(`- Email: ${runContext.customer.email}`);
    lines.push("");
    lines.push("Execute the approved loop agents in order.");
    lines.push("The ticket above is authoritative — do NOT search memory to discover this ticket.");
    lines.push("Use searchMemory only for prior customer history or FAQs (e.g. search by sender email).");
    lines.push("Classify priority (high/medium/low), then draft replies for high/medium tickets using approved templates.");
    lines.push("Create Gmail drafts via connector actions; do not send without approval.");
    return lines.join("\n");
  }

  const failureModes = definition.agentGraph?.children?.flatMap((agent) => agent.failureModes ?? []) ?? [];
  const noTicketHint = failureModes.find((mode) => /no new ticket/i.test(mode))
    ?? "No new tickets found.";
  return [
    `Execute the loop: ${definition.goal}`,
    "",
    `No trigger payload is available for this run (source=${runContext.trigger.source}).`,
    `If you cannot retrieve ticket data via connector read tools, report failure mode: ${noTicketHint}`,
  ].join("\n");
}
