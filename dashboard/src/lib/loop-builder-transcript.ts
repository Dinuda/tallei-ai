import {
  getToolName,
  isReasoningUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";

import {
  isBuilderUserFacingIssueText,
  looksLikeTechnicalIssueText,
  maskBuilderIssueText,
  stripTechnicalLinesFromText,
} from "./builder-issue-text";

export type BuilderTranscriptTextContext = {
  text: string;
  partIndex: number;
  parts: UIMessage["parts"];
  messageRole?: UIMessage["role"];
  isStreaming?: boolean;
};

export const BUILDER_TRANSCRIPT_TOOLS = new Set([
  "appSelection",
  "artifactSetup",
  "confirmActivation",
  "connectorSetup",
  "getAvailableTools",
  "interactivePrompt",
  "knowledgeBaseSetup",
  "previewAgentPlan",
  "renderType",
  "requirementSetup",
  "resolveIntent",
  "runBuilderTest",
  "saveLoop",
  "scheduleSetup",
]);

const AUTO_CONTINUE_TEXT = /^(continue|resume)$/i;

function coalesceAdjacentTextParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  const result: UIMessage["parts"] = [];
  let textBuffer = "";

  const flushText = () => {
    if (!textBuffer) return;
    result.push({ type: "text", text: textBuffer });
    textBuffer = "";
  };

  for (const part of parts) {
    if (part.type === "text") {
      textBuffer += part.text ?? "";
      continue;
    }
    flushText();
    result.push(part);
  }
  flushText();
  return result;
}

function readMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function sanitizeBuilderToolPart(part: UIMessage["parts"][number]): UIMessage["parts"][number] {
  if (!isToolUIPart(part) || part.state !== "output-error") return part;
  if (!("errorText" in part) || typeof part.errorText !== "string" || !part.errorText.trim()) {
    return part;
  }
  return {
    ...part,
    errorText: maskBuilderIssueText(part.errorText, "tool-part"),
  } as typeof part;
}

/** Keep narration in step order: reasoning → text → tool → text → tool. */
export function prepareBuilderTranscriptParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  const filtered = parts.flatMap((part) => {
    if (part.type === "text") {
      const sanitized = stripTechnicalLinesFromText(part.text ?? "", "transcript-part");
      if (!sanitized) return [];
      if (sanitized === part.text) return [part];
      return [{ ...part, text: sanitized }];
    }
    return [sanitizeBuilderToolPart(part)];
  });
  return coalesceAdjacentTextParts(filtered);
}

function lastNonEmptyTextPartIndex(parts: UIMessage["parts"]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "text" && part.text?.trim()) return index;
  }
  return -1;
}

export function isSyntheticAutoContinueMessage(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  const text = readMessageText(message);
  // Only suppress explicit auto-continue text. Empty messages (no text parts)
  // may carry tool-output continuations and must not be hidden here.
  return Boolean(text) && AUTO_CONTINUE_TEXT.test(text);
}

function dedupeChatMessagesById(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>();
  const deduped: UIMessage[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    deduped.push(message);
  }
  return deduped;
}

export function filterBuilderTranscriptMessages(messages: UIMessage[]): UIMessage[] {
  return dedupeChatMessagesById(messages).filter(
    (message) => !isSyntheticAutoContinueMessage(message),
  );
}

function messageHasBuilderTools(parts: UIMessage["parts"]): boolean {
  return parts.some(
    (part) => isToolUIPart(part) && BUILDER_TRANSCRIPT_TOOLS.has(getToolName(part)),
  );
}

/** Hide short filler narration between builder setup tool cards. */
export function shouldRenderBuilderTranscriptText(ctx: BuilderTranscriptTextContext): boolean {
  const trimmed = ctx.text.trim();
  if (!trimmed) return false;

  if (looksLikeTechnicalIssueText(trimmed) && !isBuilderUserFacingIssueText(trimmed)) {
    return false;
  }

  if (!messageHasBuilderTools(ctx.parts)) return true;

  const lastTextIndex = lastNonEmptyTextPartIndex(ctx.parts);
  const isLastNarration = ctx.partIndex === lastTextIndex;

  // While streaming, grow the active tail but keep settled narration visible.
  if (ctx.isStreaming) {
    if (isLastNarration) return true;
    if (trimmed.length >= 24) return true;
    const next = ctx.parts[ctx.partIndex + 1];
    if (touchesCompletedBuilderTool(next) || touchesPendingBuilderTool(next)) return true;
    return false;
  }

  // After the turn settles, keep every substantive narration block visible.
  if (trimmed.length >= 24) return true;

  // Brief copy directly before a pending builder tool is still useful context.
  const next = ctx.parts[ctx.partIndex + 1];
  if (touchesPendingBuilderTool(next)) return true;

  return false;
}

function touchesPendingBuilderTool(part: UIMessage["parts"][number] | undefined): boolean {
  if (!part || !isToolUIPart(part) || !BUILDER_TRANSCRIPT_TOOLS.has(getToolName(part))) return false;
  return part.state === "input-available" || part.state === "input-streaming";
}

function touchesCompletedBuilderTool(part: UIMessage["parts"][number] | undefined): boolean {
  if (!part || !isToolUIPart(part) || !BUILDER_TRANSCRIPT_TOOLS.has(getToolName(part))) return false;
  return part.state === "output-available" || part.state === "output-error";
}

const PENDING_TOOL_NARRATION: Record<string, string> = {
  appSelection: "Which app do your customers use to reach out for support?",
  artifactSetup: "Review and confirm the reply templates for this loop.",
  connectorSetup: "Connect the apps this loop needs to work.",
  knowledgeBaseSetup: "Choose which knowledge sources this loop should use.",
  outputReviewGatesSetup: "Choose when this loop should pause for your review.",
  renderType: "Preparing support reply templates for this loop.",
  scheduleSetup: "Choose when this loop should run.",
};

function readPendingToolNarration(part: UIMessage["parts"][number]): string | null {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  if (!BUILDER_TRANSCRIPT_TOOLS.has(toolName)) return null;
  if (part.state !== "input-available" || !isBuilderToolInputReady(part)) return null;

  const input = part.input && typeof part.input === "object"
    ? part.input as Record<string, unknown>
    : {};
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question) return question;
  return PENDING_TOOL_NARRATION[toolName] ?? null;
}

function messageHasVisibleNarration(
  parts: UIMessage["parts"],
  options?: { isStreaming?: boolean },
): boolean {
  const coalesced = coalesceAdjacentTextParts(parts);
  for (let partIndex = 0; partIndex < coalesced.length; partIndex += 1) {
    const part = coalesced[partIndex];
    if (part?.type !== "text") continue;
    if (shouldRenderBuilderTranscriptText({
      text: part.text ?? "",
      partIndex,
      parts: coalesced,
      messageRole: "assistant",
      isStreaming: options?.isStreaming,
    })) {
      return true;
    }
  }
  return false;
}

/** Intro copy for pending composer tools when the model skipped narration text. */
export function builderFallbackNarration(
  parts: UIMessage["parts"],
  options?: { isStreaming?: boolean },
): string | null {
  if (options?.isStreaming) return null;
  if (messageHasVisibleNarration(parts, options)) return null;

  const coalesced = coalesceAdjacentTextParts(parts);
  for (let index = coalesced.length - 1; index >= 0; index -= 1) {
    const narration = readPendingToolNarration(coalesced[index]!);
    if (narration) return narration;
  }
  return null;
}

export function isBuilderToolInputReady(part: UIMessage["parts"][number]): boolean {
  if (!isToolUIPart(part) || part.state !== "input-available") return false;
  const toolName = getToolName(part);
  if (!BUILDER_TRANSCRIPT_TOOLS.has(toolName)) return false;

  const input = part.input && typeof part.input === "object"
    ? part.input as Record<string, unknown>
    : null;
  if (!input) return false;

  if (toolName === "requirementSetup" || toolName === "interactivePrompt") {
    return typeof input.question === "string"
      && Array.isArray(input.options)
      && input.options.length > 0;
  }

  return true;
}

function builderToolPartIsVisible(part: UIMessage["parts"][number]): boolean {
  if (!isToolUIPart(part)) return false;
  const toolName = getToolName(part);
  if (!BUILDER_TRANSCRIPT_TOOLS.has(toolName)) return false;
  if (part.state === "output-available") return true;
  return false;
}

export function isReasoningOnlyAssistantMessage(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;

  let hasReasoning = false;
  let hasUserFacingContent = false;

  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) {
      hasUserFacingContent = true;
      break;
    }
    if (isToolUIPart(part)) {
      hasUserFacingContent = true;
      break;
    }
    if (isReasoningUIPart(part) && (part.text?.trim() || part.state === "streaming")) {
      hasReasoning = true;
    }
  }

  return hasReasoning && !hasUserFacingContent;
}

export function assistantMessageHasVisibleContent(
  message: UIMessage,
  options?: { isStreaming?: boolean },
): boolean {
  if (message.role !== "assistant") return false;
  if (isReasoningOnlyAssistantMessage(message)) return false;

  const parts = coalesceAdjacentTextParts(message.parts);
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    if (!part) continue;

    if (part.type === "text") {
      if (shouldRenderBuilderTranscriptText({
        text: part.text ?? "",
        partIndex,
        parts,
        messageRole: message.role,
        isStreaming: options?.isStreaming,
      })) {
        return true;
      }
      continue;
    }

    if (isReasoningUIPart(part)) {
      if (part.text?.trim() || part.state === "streaming") return true;
      continue;
    }

    if (builderToolPartIsVisible(part)) return true;
  }

  return false;
}

function latestAssistantMessage(messages: UIMessage[]): UIMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return null;
}

export function shouldShowBuilderThinking(input: {
  status: string;
  messages: UIMessage[];
  hasComposerGate: boolean;
}): boolean {
  if (input.hasComposerGate) return false;
  if (input.status !== "submitted" && input.status !== "streaming") return false;

  if (input.status === "submitted") return true;

  const latestAssistant = latestAssistantMessage(input.messages);
  if (!latestAssistant) return true;

  return !assistantMessageHasVisibleContent(latestAssistant, { isStreaming: true });
}
