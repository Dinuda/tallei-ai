import {
  convertToModelMessages,
  MissingToolResultsError,
  type ModelMessage,
  type UIMessage,
} from "ai";

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

/** Canonicalize event-log input without mutating tool lifecycle state. */
export function prepareConductorChatMessagesForEventLog(messages: UIMessage[]): UIMessage[] {
  return normalizeConductorChatMessages(
    messages.map((message) => ({
      ...message,
      parts: (message.parts ?? []).map((part) => stripOpenAiItemIds(part) as UIMessage["parts"][number]),
    })),
  );
}

const CONDUCTOR_UI_ONLY_TOOLS = new Set([
  "askQuestion",
  "pickConnectorApp",
  "presentReplyOptions",
  "confirmOutcomeBrief",
]);

const SUPERSEDED_TOOL_ERROR = "Superseded by a later user message before this tool completed.";

function isToolPartType(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

function isTerminalToolState(state: string | undefined): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
}

function isUnresolvedToolPart(part: { type: string; state?: string }): boolean {
  if (!isToolPartType(part.type)) return false;
  const state = part.state;
  if (!state || state === "input-streaming") return false;
  return !isTerminalToolState(state);
}

function hasLaterUserMessage(messages: UIMessage[], assistantIndex: number, lastUserIndex: number): boolean {
  if (lastUserIndex <= assistantIndex) return false;
  return messages.slice(assistantIndex + 1, lastUserIndex + 1).some((message) => message.role === "user");
}

function repairSupersededToolPart(rawPart: UIMessage["parts"][number]): UIMessage["parts"][number] {
  return {
    ...rawPart,
    state: "output-error",
    output: {
      interrupted: true,
      supersededByUserMessage: true,
      skipped: true,
    },
    errorText: SUPERSEDED_TOOL_ERROR,
  } as UIMessage["parts"][number];
}

export type ConductorReplaySanitizeStats = {
  repairedToolCallIds: string[];
  prunedMessageIds: string[];
};

export type SanitizeConductorReplayOptions = {
  aggressive?: boolean;
};

function findLastUserMessageIndex(messages: UIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

/** Repair orphaned tool calls before AI SDK model conversion. Does not mutate persisted event-log state. */
export function sanitizeConductorChatMessagesForModelReplay(
  messages: UIMessage[],
  options: SanitizeConductorReplayOptions = {},
): { messages: UIMessage[]; stats: ConductorReplaySanitizeStats } {
  const stats: ConductorReplaySanitizeStats = {
    repairedToolCallIds: [],
    prunedMessageIds: [],
  };
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex < 0) {
    return { messages, stats };
  }

  const repaired = messages.flatMap((message, index) => {
    if (message.role !== "assistant" || index >= lastUserIndex) {
      return [message];
    }
    if (!hasLaterUserMessage(messages, index, lastUserIndex)) {
      return [message];
    }

    let changed = false;
    const parts = (message.parts ?? []).flatMap((rawPart) => {
      const part = rawPart as { type: string; toolCallId?: string; state?: string };
      if (!isUnresolvedToolPart(part)) return [rawPart];
      if (options.aggressive) {
        changed = true;
        if (part.toolCallId) stats.repairedToolCallIds.push(part.toolCallId);
        return [];
      }
      changed = true;
      if (part.toolCallId) stats.repairedToolCallIds.push(part.toolCallId);
      return [repairSupersededToolPart(rawPart)];
    });

    if (!changed) return [message];
    const nextMessage = { ...message, parts };
    if (!hasVisibleContent(nextMessage)) {
      stats.prunedMessageIds.push(message.id);
      return [];
    }
    return [nextMessage];
  });

  return {
    messages: normalizeConductorChatMessages(repaired),
    stats,
  };
}

export function findOrphanedToolCallIdsFromModelMessages(messages: ModelMessage[]): string[] {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (part.type === "tool-call" && !("providerExecuted" in part && part.providerExecuted)) {
          pending.add(part.toolCallId);
        }
      }
      continue;
    }
    if (message.role === "tool") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (part.type === "tool-result") {
          pending.delete(part.toolCallId);
        }
      }
      continue;
    }
    if (message.role === "user" && pending.size > 0) {
      return [...pending];
    }
  }
  return pending.size > 0 ? [...pending] : [];
}

export async function prepareConductorModelMessagesForStream(
  messages: UIMessage[],
): Promise<{ modelMessages: ModelMessage[]; replayMessages: UIMessage[]; stats: ConductorReplaySanitizeStats }> {
  let { messages: replayMessages, stats } = sanitizeConductorChatMessagesForModelReplay(messages);
  let modelMessages = await convertToModelMessages(replayMessages);
  let orphaned = findOrphanedToolCallIdsFromModelMessages(modelMessages);
  if (orphaned.length === 0) {
    return { modelMessages, replayMessages, stats };
  }

  const aggressive = sanitizeConductorChatMessagesForModelReplay(messages, { aggressive: true });
  replayMessages = aggressive.messages;
  stats = {
    repairedToolCallIds: [...new Set([...stats.repairedToolCallIds, ...aggressive.stats.repairedToolCallIds])],
    prunedMessageIds: [...new Set([...stats.prunedMessageIds, ...aggressive.stats.prunedMessageIds])],
  };
  modelMessages = await convertToModelMessages(replayMessages, { ignoreIncompleteToolCalls: true });
  orphaned = findOrphanedToolCallIdsFromModelMessages(modelMessages);
  if (orphaned.length > 0) {
    throw new MissingToolResultsError({ toolCallIds: orphaned });
  }
  return { modelMessages, replayMessages, stats };
}

export function isMissingToolResultsError(error: unknown): error is MissingToolResultsError {
  return MissingToolResultsError.isInstance(error);
}

export { CONDUCTOR_UI_ONLY_TOOLS, SUPERSEDED_TOOL_ERROR };
