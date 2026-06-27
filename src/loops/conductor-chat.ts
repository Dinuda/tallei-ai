import type { UIMessage } from "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasVisibleContent(message: UIMessage): boolean {
  const parts = message.parts ?? [];
  if (parts.length === 0) return false;
  return parts.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0;
    if (part.type === "reasoning") return part.text.trim().length > 0;
    if (part.type.startsWith("tool-")) return true;
    return false;
  });
}

/** Drop nulls, empty assistant placeholders, and duplicate message ids. */
export function normalizeConductorChatMessages(messages: Array<UIMessage | null | undefined>): UIMessage[] {
  const seen = new Set<string>();
  const normalized: UIMessage[] = [];
  for (const message of messages) {
    if (!message || !message.id || !message.role) continue;
    if (seen.has(message.id)) continue;
    if (message.role === "assistant" && !hasVisibleContent(message)) continue;
    seen.add(message.id);
    normalized.push({
      id: message.id,
      role: message.role,
      parts: message.parts ?? [],
    });
  }
  return normalized;
}

function stripOpenAiItemIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOpenAiItemIds);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "itemId") continue;
    next[key] = stripOpenAiItemIds(child);
  }
  return next;
}

/** Remove provider item ids that break replay while keeping reasoning payloads. */
export function sanitizeConductorChatMessages(messages: UIMessage[]): UIMessage[] {
  return normalizeConductorChatMessages(
    messages.map((message) => ({
      ...message,
      parts: (message.parts ?? []).map((part) => stripOpenAiItemIds(part) as UIMessage["parts"][number]),
    })),
  );
}

export function parseStoredConductorChatMessages(raw: unknown): UIMessage[] {
  if (!Array.isArray(raw)) return [];
  return sanitizeConductorChatMessages(raw as UIMessage[]);
}
