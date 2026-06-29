function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) return value;
  }
  return undefined;
}

/** Best-effort extract stable ids from a Composio trigger webhook payload for planner context. */
export function extractTriggerKnownFields(
  payload: unknown,
  triggerSlug?: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const root = asRecord(payload);
  if (!root) return fields;

  const nested = asRecord(root.payload) ?? asRecord(root.data) ?? {};
  const metadata = {
    ...asRecord(root.metadata) ?? {},
    ...asRecord(nested.metadata) ?? {},
  };

  const messageId = pickString(
    nested.message_id,
    nested.messageId,
    nested.id,
    root.message_id,
    root.messageId,
    metadata.message_id,
    metadata.messageId,
  );
  const threadId = pickString(
    nested.thread_id,
    nested.threadId,
    root.thread_id,
    root.threadId,
    metadata.thread_id,
    metadata.threadId,
  );
  const subject = pickString(nested.subject, root.subject, metadata.subject);
  const from = pickString(
    nested.from,
    nested.sender,
    root.from,
    root.sender,
    metadata.from,
    metadata.sender,
  );

  if (messageId) fields.message_id = messageId;
  if (threadId) fields.thread_id = threadId;
  if (messageId && threadId) {
    fields.gmail_id_note = "Use message_id (not thread_id) for email.get and email.labels tools.";
  } else if (threadId && !messageId) {
    fields.gmail_id_note = "Only thread_id in trigger — call email.read first; do not pass thread_id to label/get tools.";
  }
  if (subject) fields.subject = subject;
  if (from) fields.from = from;
  if (triggerSlug) fields.trigger_slug = triggerSlug;

  return fields;
}

export function formatTriggerKnownFields(fields: Record<string, string>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}
