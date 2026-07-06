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

export type TriggerFieldSpec = {
  name: string;
  type: "string" | "number" | "boolean" | "array";
  aliases?: string[];
  description?: string;
  /** When true, the field may appear on some webhook payloads but is not guaranteed. */
  optional?: boolean;
};

/** Canonical trigger output fields keyed by Composio trigger slug. */
export const TRIGGER_OUTPUT_FIELDS: Record<string, TriggerFieldSpec[]> = {
  GMAIL_NEW_GMAIL_MESSAGE: [
    { name: "message_id", type: "string", aliases: ["messageId", "id"], description: "Gmail message id" },
    { name: "thread_id", type: "string", aliases: ["threadId"], description: "Gmail thread id", optional: true },
    { name: "subject", type: "string", description: "Email subject" },
    { name: "from", type: "string", aliases: ["sender"], description: "Sender address" },
    { name: "to", type: "string", description: "Recipient address" },
    { name: "body", type: "string", aliases: ["snippet", "text"], description: "Message body or snippet" },
  ],
};

export function normalizeTriggerSlug(slug: string): string {
  return slug.trim().toUpperCase();
}

export function getTriggerOutputFields(triggerSlug: string): TriggerFieldSpec[] {
  return TRIGGER_OUTPUT_FIELDS[normalizeTriggerSlug(triggerSlug)] ?? [];
}

/** Fields the trigger is expected to reliably emit (non-optional catalog entries). */
export function getTriggerFieldNamesForFeasibility(triggerSlug: string): string[] {
  return getTriggerOutputFields(triggerSlug)
    .filter((field) => !field.optional)
    .map((field) => field.name);
}

export function getAllTriggerOutputFieldNames(triggerSlug: string): string[] {
  return getTriggerOutputFields(triggerSlug).map((field) => field.name);
}

function sampleValueForField(field: TriggerFieldSpec): unknown {
  switch (field.type) {
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return ["sample"];
    default:
      return `test-${field.name}`;
  }
}

/** Build a canonical snake_case trigger payload for test runs and smoke scenarios. */
export function buildSampleTriggerPayload(triggerSlug: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of getTriggerOutputFields(triggerSlug)) {
    payload[field.name] = sampleValueForField(field);
  }
  return payload;
}

function readPayloadRoots(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  if (!root) return [];
  const nested = asRecord(root.payload) ?? asRecord(root.data) ?? {};
  const metadata = {
    ...asRecord(root.metadata) ?? {},
    ...asRecord(nested.metadata) ?? {},
  };
  return [root, nested, metadata];
}

function pickFieldValue(roots: Record<string, unknown>[], names: string[]): unknown {
  for (const name of names) {
    for (const root of roots) {
      const value = root[name];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

/** Normalize webhook / scenario payloads to canonical snake_case trigger fields. */
export function extractCanonicalTriggerPayload(
  payload: unknown,
  triggerSlug?: string,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  const roots = readPayloadRoots(payload);
  const specs = triggerSlug ? getTriggerOutputFields(triggerSlug) : [];

  for (const spec of specs) {
    const names = [spec.name, ...(spec.aliases ?? [])];
    const value = pickFieldValue(roots, names);
    if (value !== undefined && value !== null && value !== "") {
      canonical[spec.name] = value;
    }
  }

  if (specs.length === 0) {
    for (const root of roots) {
      for (const [key, value] of Object.entries(root)) {
        if (value !== undefined && value !== null && value !== "") {
          canonical[key] = value;
        }
      }
    }
  }

  return canonical;
}

/** Best-effort extract stable ids from a Composio trigger webhook payload for planner context. */
export function extractTriggerKnownFields(
  payload: unknown,
  triggerSlug?: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const canonical = extractCanonicalTriggerPayload(payload, triggerSlug);

  for (const [key, value] of Object.entries(canonical)) {
    if (typeof value === "string" && value.trim()) {
      fields[key] = value.trim();
    }
  }

  const messageId = fields.message_id;
  const threadId = fields.thread_id;
  if (messageId && threadId) {
    fields.gmail_id_note = "Pass message_id to tools whose input schema includes message_id.";
  } else if (threadId && !messageId) {
    fields.gmail_id_note = "Only thread_id in trigger — pick a tool whose schema accepts thread_id or list messages first.";
  }
  if (triggerSlug) fields.trigger_slug = triggerSlug;

  return fields;
}

export function formatTriggerKnownFields(fields: Record<string, string>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}
