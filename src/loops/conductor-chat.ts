import {
  convertToModelMessages,
  MissingToolResultsError,
  type ModelMessage,
  type UIMessage,
} from "ai";

import {
  CONDUCTOR_UI_ONLY_TOOLS,
  CONDUCTOR_INTERNAL_TRANSCRIPT_TOOLS,
} from "@tallei/conductor-tools/tool-names.js";

export { CONDUCTOR_INTERNAL_TRANSCRIPT_TOOLS };

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
    const next: UIMessage = {
      id: message.id,
      role: message.role,
      parts: message.parts ?? [],
    };
    if (message.metadata !== undefined) {
      next.metadata = message.metadata;
    }
    normalized.push(next);
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
    ensureVisibleConductorAssistantTurn(messages).map((message) => ({
      ...message,
      parts: (message.parts ?? []).map((part) => {
        const stripped = stripOpenAiItemIds(part) as UIMessage["parts"][number];
        // Persist completed reasoning so refresh does not keep a live "Thinking..." shimmer.
        if (stripped.type === "reasoning") {
          const reasoning = stripped as { type: "reasoning"; text?: string; state?: string };
          if (reasoning.state === "streaming") {
            return { ...reasoning, state: "done" } as UIMessage["parts"][number];
          }
        }
        return stripped;
      }),
    })),
  );
}

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

function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function extractUserText(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function firstUserTextAfter(messages: UIMessage[], assistantIndex: number, lastUserIndex: number): string {
  for (let index = assistantIndex + 1; index <= lastUserIndex; index += 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = extractUserText(message);
    if (text) return text;
  }
  return "";
}

function isContinueLikeMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ["continue", "yes", "okay", "ok", "go ahead", "proceed", "sure"].includes(normalized);
}

function inferUiToolOutputFromUserText(
  toolName: string,
  input: unknown,
  userText: string,
): unknown | null {
  if (toolName === "confirmOutcomeBrief" && isContinueLikeMessage(userText) && isRecord(input)) {
    const options = Array.isArray(input.options)
      ? input.options as Array<{ id?: string; value?: string; label?: string }>
      : [];
    const confirmOption = options.find((option) => option.value === "confirm" || option.id === "confirm");
    if (confirmOption?.id && confirmOption.value) {
      return {
        action: "confirm",
        briefHash: input.briefHash,
        answerText: userText,
        selectedOptionIds: [confirmOption.id],
        selectedValues: [confirmOption.value],
      };
    }
  }
  return null;
}

function repairUiToolWithUserAnswer(
  rawPart: UIMessage["parts"][number],
  userText: string,
): UIMessage["parts"][number] | null {
  const part = rawPart as { type: string; toolName?: string; input?: unknown };
  const resolvedToolName = resolveToolPartName(part);
  if (!CONDUCTOR_UI_ONLY_TOOLS.has(resolvedToolName)) return null;
  const output = inferUiToolOutputFromUserText(resolvedToolName, part.input, userText);
  if (!output) return null;
  return {
    ...rawPart,
    state: "output-available",
    output,
  } as UIMessage["parts"][number];
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
  } as unknown as UIMessage["parts"][number];
}

export type ConductorReplaySanitizeStats = {
  repairedToolCallIds: string[];
  prunedMessageIds: string[];
};

export type SanitizeConductorReplayOptions = {
  aggressive?: boolean;
  /** Event-log open UI tool calls that should not be marked superseded during replay. */
  preserveOpenUiToolCallIds?: ReadonlySet<string>;
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
      const part = rawPart as { type: string; toolCallId?: string; state?: string; input?: unknown; toolName?: string };
      if (!isUnresolvedToolPart(part)) return [rawPart];
      const toolCallId = part.toolCallId ?? "";
      const userText = firstUserTextAfter(messages, index, lastUserIndex);
      const resolvedFromUser = userText ? repairUiToolWithUserAnswer(rawPart, userText) : null;
      if (resolvedFromUser) {
        changed = true;
        if (toolCallId) stats.repairedToolCallIds.push(toolCallId);
        return [resolvedFromUser];
      }
      if (toolCallId && options.preserveOpenUiToolCallIds?.has(toolCallId)) {
        return [rawPart];
      }
      if (options.aggressive) {
        changed = true;
        if (toolCallId) stats.repairedToolCallIds.push(toolCallId);
        return [];
      }
      changed = true;
      if (toolCallId) stats.repairedToolCallIds.push(toolCallId);
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
  options: SanitizeConductorReplayOptions = {},
): Promise<{ modelMessages: ModelMessage[]; replayMessages: UIMessage[]; stats: ConductorReplaySanitizeStats }> {
  let { messages: replayMessages, stats } = sanitizeConductorChatMessagesForModelReplay(messages, options);
  let modelMessages = await convertToModelMessages(replayMessages);
  let orphaned = findOrphanedToolCallIdsFromModelMessages(modelMessages);
  if (orphaned.length === 0) {
    return { modelMessages, replayMessages, stats };
  }

  const aggressive = sanitizeConductorChatMessagesForModelReplay(messages, { ...options, aggressive: true });
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

type ToolLikePart = {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
};

function resolveToolPartNameFromPart(part: ToolLikePart): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function isUserVisibleTranscriptPart(part: UIMessage["parts"][number]): boolean {
  if (part.type === "text") {
    return "text" in part && typeof part.text === "string" && part.text.trim().length > 0;
  }
  if (part.type === "reasoning") return false;
  if (!isToolPartType(part.type)) return false;
  const name = resolveToolPartNameFromPart(part as ToolLikePart);
  return !CONDUCTOR_INTERNAL_TRANSCRIPT_TOOLS.has(name);
}

function hasUserVisibleTranscriptContent(message: UIMessage): boolean {
  return (message.parts ?? []).some(isUserVisibleTranscriptPart);
}

function buildFallbackAssistantText(message: UIMessage, context?: ConductorStallRecoveryContext): string {
  if (context?.streamError) {
    return `I hit a temporary issue while working on this step. Send your message again to continue.`;
  }

  const hasFailedTool = (message.parts ?? []).some((part) => {
    if (!isToolPartType(part.type)) return false;
    const toolPart = part as ToolLikePart;
    return toolPart.state === "output-error";
  });
  if (hasFailedTool) {
    return "One of the workflow setup steps failed. Tell me what to change, or send **continue** to retry.";
  }

  for (const part of message.parts ?? []) {
    if (!isToolPartType(part.type)) continue;
    const toolPart = part as ToolLikePart;
    const name = resolveToolPartNameFromPart(toolPart);
    if (name === "askQuestion" || name === "pickConnectorApp") {
      const question = typeof toolPart.input === "object"
        && toolPart.input
        && "question" in toolPart.input
        && typeof toolPart.input.question === "string"
        ? toolPart.input.question.trim()
        : "";
      if (question) return question;
    }
  }

  const hasPendingQuestion = (message.parts ?? []).some((part) => {
    if (!isToolPartType(part.type)) return false;
    const toolPart = part as ToolLikePart;
    const name = resolveToolPartNameFromPart(toolPart);
    return CONDUCTOR_UI_ONLY_TOOLS.has(name)
      && (toolPart.state === "input-available" || toolPart.state === "input-streaming");
  });
  if (hasPendingQuestion || context?.pendingUiTool) {
    return "I need one answer from you to continue building this workflow.";
  }

  const hasReasoningOnly = (message.parts ?? []).some((part) => part.type === "reasoning")
    && !(message.parts ?? []).some((part) => part.type === "text" && part.text.trim().length > 0);
  if (hasReasoningOnly && context?.stepsUsed === 0) {
    return "I finished thinking but didn't advance the workflow yet. Send **continue** and I'll pick up from here.";
  }

  if (context?.outcome === "blocked") {
    return "I couldn't make more progress on this step. Tell me what to change, or send **continue** to retry.";
  }

  return "I captured the workflow intent and need one answer to continue.";
}

export type ConductorStallRecoveryContext = {
  streamError?: string | null;
  stepsUsed?: number;
  outcome?: string;
  resolutionReason?: string;
  pendingUiTool?: { toolName?: string; toolCallId?: string } | null;
};

function assistantHasRecoverableVisibleText(message: UIMessage): boolean {
  return (message.parts ?? []).some((part) => {
    if (part.type !== "text") return false;
    const text = part.text.trim();
    return text.length > 0;
  });
}

/** Append a short user-facing sentence when a turn ends with only hidden tools or reasoning. */
export function ensureVisibleConductorAssistantTurn(
  messages: UIMessage[],
  context?: ConductorStallRecoveryContext,
): UIMessage[] {
  if (messages.length === 0) return messages;

  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex < 0) return messages;

  const message = messages[lastAssistantIndex]!;
  if (hasUserVisibleTranscriptContent(message)) return messages;
  if (assistantHasRecoverableVisibleText(message)) return messages;

  const nextMessage: UIMessage = {
    ...message,
    parts: [
      ...(message.parts ?? []),
      { type: "text", text: buildFallbackAssistantText(message, context) },
    ],
  };

  return messages.map((item, index) => (index === lastAssistantIndex ? nextMessage : item));
}

/** Add a recoverable assistant sentence after a stalled turn if the transcript still looks blank. */
export function appendConductorStallRecoveryMessage(
  messages: UIMessage[],
  context: ConductorStallRecoveryContext,
): UIMessage[] {
  return ensureVisibleConductorAssistantTurn(messages, context);
}

/** Revision for client persistence dedupe; ignores streaming reasoning token deltas. */
export function messagesPersistenceRevision(messages: UIMessage[]): string {
  return messages.map((message) => {
    const parts = (message.parts ?? []).map((part) => {
      if (part.type === "text") {
        return `t:${part.text?.length ?? 0}`;
      }
      if (part.type === "reasoning") {
        const reasoning = part as { state?: string; text?: string };
        if (reasoning.state === "streaming") return "r:streaming";
        return `r:${reasoning.state ?? "done"}:${reasoning.text?.length ?? 0}`;
      }
      if (isToolPartType(part.type)) {
        const toolPart = part as ToolLikePart;
        return `tool:${toolPart.toolCallId ?? ""}:${toolPart.state ?? ""}:${toolPart.output != null ? 1 : 0}`;
      }
      return part.type;
    }).join(",");
    return `${message.id}:${parts}`;
  }).join("|");
}

export { CONDUCTOR_UI_ONLY_TOOLS, SUPERSEDED_TOOL_ERROR };
