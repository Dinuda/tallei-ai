import type { UIMessage } from "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function findStaleConfirmOutcomeBriefCalls(messages: UIMessage[]): Array<{ toolCallId: string; briefHash: string }> {
  const stale: Array<{ toolCallId: string; briefHash: string }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j];
      if (resolveToolPartName(part as { type: string; toolName?: string }) !== "confirmOutcomeBrief") continue;
      const toolPart = part as {
        toolCallId: string;
        state?: string;
        output?: unknown;
        input?: { briefHash?: string };
      };
      if (toolPart.state !== "input-available" || toolPart.output != null) continue;
      const confirmHash = toolPart.input?.briefHash;
      if (!confirmHash) continue;

      let superseded = false;
      outer: for (let mi = i; mi < messages.length; mi += 1) {
        const laterMessage = messages[mi];
        if (laterMessage.role !== "assistant") continue;
        const laterParts = laterMessage.parts ?? [];
        const startJ = mi === i ? j + 1 : 0;
        for (let mj = startJ; mj < laterParts.length; mj += 1) {
          const laterPart = laterParts[mj];
          if (resolveToolPartName(laterPart as { type: string; toolName?: string }) !== "reviewOutcomeBrief") {
            continue;
          }
          const reviewPart = laterPart as { state?: string; output?: { briefHash?: string } };
          if (reviewPart.state !== "output-available" || !reviewPart.output?.briefHash) continue;
          if (reviewPart.output.briefHash !== confirmHash) {
            superseded = true;
            break outer;
          }
        }
      }

      if (superseded) {
        stale.push({ toolCallId: toolPart.toolCallId, briefHash: confirmHash });
      }
    }
  }
  return stale;
}

/** Close orphaned confirmOutcomeBrief calls superseded by a later reviewOutcomeBrief. */
export function repairStaleOutcomeBriefConfirms(messages: UIMessage[]): UIMessage[] {
  const staleIds = new Set(findStaleConfirmOutcomeBriefCalls(messages).map((row) => row.toolCallId));
  if (staleIds.size === 0) return messages;

  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const parts = message.parts ?? [];
    let changed = false;
    const nextParts = parts.map((part) => {
      const toolPart = part as {
        type: string;
        toolName?: string;
        toolCallId?: string;
        state?: string;
        output?: unknown;
        input?: { briefHash?: string };
      };
      if (resolveToolPartName(toolPart) !== "confirmOutcomeBrief") return part;
      if (!toolPart.toolCallId || !staleIds.has(toolPart.toolCallId)) return part;
      if (toolPart.state !== "input-available" || toolPart.output != null) return part;
      const briefHash = toolPart.input?.briefHash;
      if (!briefHash) return part;
      changed = true;
      return {
        ...part,
        state: "output-available",
        output: {
          action: "other",
          briefHash,
          otherText: "Superseded by updated outcome brief",
        },
      } as UIMessage["parts"][number];
    });
    return changed ? { ...message, parts: nextParts } : message;
  });
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
  return repairStaleOutcomeBriefConfirms(
    normalizeConductorChatMessages(
      messages.map((message) => ({
        ...message,
        parts: (message.parts ?? []).map((part) => stripOpenAiItemIds(part) as UIMessage["parts"][number]),
      })),
    ),
  );
}

export function parseStoredConductorChatMessages(raw: unknown): UIMessage[] {
  if (!Array.isArray(raw)) return [];
  return sanitizeConductorChatMessages(raw as UIMessage[]);
}
