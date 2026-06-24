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

const byComposioSlug = new Map<string, { source: string; eventType: string }>();
for (const row of TRIGGER_MAPPINGS) {
  const key = row.composioSlug.toUpperCase();
  if (!byComposioSlug.has(key)) {
    byComposioSlug.set(key, { source: row.source, eventType: row.eventType });
  }
}

/** Static alias lookup only — does not guess slugs. */
export function lookupStaticTriggerSlug(source: string, eventType: string): string | null {
  const normalizedSource = normalizeToolkitSlug(source);
  const normalizedEvent = eventType.trim();
  const mapped = bySourceEvent.get(normalizeKey(normalizedSource, normalizedEvent));
  if (mapped) return mapped;
  if (/^[A-Z][A-Z0-9_]+$/.test(normalizedEvent)) return normalizedEvent;
  return null;
}

/** @deprecated Prefer resolveTriggerSlugWithCatalog at activation time. */
export function resolveComposioTriggerSlug(source: string, eventType: string): string {
  const staticSlug = lookupStaticTriggerSlug(source, eventType);
  if (staticSlug) return staticSlug;
  const normalizedSource = normalizeToolkitSlug(source);
  const normalizedEvent = eventType.trim();
  return `${normalizedSource.toUpperCase()}_${normalizedEvent.replace(/[.\s-]+/g, "_").toUpperCase()}`;
}

export function resolveTriggerFromComposioSlug(
  triggerSlug: string,
): { source: string; eventType: string } | null {
  const slug = triggerSlug.trim().toUpperCase();
  if (!slug) return null;
  const mapped = byComposioSlug.get(slug);
  if (mapped) return mapped;
  const toolkit = slug.includes("_") ? slug.split("_")[0]!.toLowerCase() : "";
  if (!toolkit) return null;
  return { source: normalizeToolkitSlug(toolkit), eventType: slug.toLowerCase() };
}

export function scoreTriggerSlugMatch(
  eventType: string,
  slug: string,
  name: string,
): number {
  const tokens = eventType.toLowerCase().split(/[._\s-]+/).filter(Boolean);
  const hay = `${slug} ${name}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += 2;
  }
  if (tokens.some((t) => ["new", "created", "received", "posted"].includes(t)) && hay.includes("new")) {
    score += 1;
  }
  return score;
}
