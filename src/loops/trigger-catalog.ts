import { normalizeToolkitSlug } from "../integrations/composio/auth.js";

type TriggerMapping = {
  source: string;
  eventType: string;
  composioSlug: string;
};

const TRIGGER_MAPPINGS: TriggerMapping[] = [
  { source: "gmail", eventType: "new_message", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "gmail", eventType: "email.received", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "gmail", eventType: "message.new", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "gmail", eventType: "message_new", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "gmail", eventType: "new.email", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "gmail", eventType: "email.new", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "gmail", eventType: "incoming.email", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "gmail", eventType: "new_email", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
  { source: "zendesk", eventType: "ticket.created", composioSlug: "ZENDESK_NEW_TICKET" },
  { source: "zendesk", eventType: "ticket.new", composioSlug: "ZENDESK_NEW_TICKET" },
  { source: "slack", eventType: "message.posted", composioSlug: "SLACK_RECEIVE_MESSAGE" },
  { source: "slack", eventType: "message.new", composioSlug: "SLACK_RECEIVE_MESSAGE" },
  { source: "hubspot", eventType: "lead.created", composioSlug: "HUBSPOT_NEW_CONTACT" },
  { source: "hubspot", eventType: "contact.created", composioSlug: "HUBSPOT_NEW_CONTACT" },
];

function normalizeKey(source: string, eventType: string): string {
  return `${normalizeToolkitSlug(source)}:${eventType.trim().toLowerCase()}`;
}

const bySourceEvent = new Map(
  TRIGGER_MAPPINGS.map((row) => [normalizeKey(row.source, row.eventType), row.composioSlug]),
);

/** Static alias lookup — does not guess unknown slugs. */
export function lookupStaticTriggerSlug(source: string, eventType: string): string | null {
  const normalizedSource = normalizeToolkitSlug(source);
  const normalizedEvent = eventType.trim();
  const mapped = bySourceEvent.get(normalizeKey(normalizedSource, normalizedEvent));
  if (mapped) return mapped;
  if (/^[A-Z][A-Z0-9_]+$/.test(normalizedEvent)) return normalizedEvent;
  return null;
}
