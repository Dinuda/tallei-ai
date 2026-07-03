import {
  lastAssistantMessageIsCompleteWithToolCalls,
  type DynamicToolUIPart,
  type ReasoningUIPart,
  type UIMessage,
} from "ai";

import type { InteractivePromptOption } from "@/components/ai-elements/interactive-prompt-menu";
import type {
  PresentReplyOptionsInput,
  PresentReplyOptionsOutput,
} from "@/lib/conductor-prompt-suggestions";

export type BindingRow = { connector: string; capability: string; role?: string };

export type BlueprintOutcome = {
  id: string;
  role: string;
  description: string;
  selectedConnector?: string;
  status: string;
};

export type TaskBlueprint = {
  summary?: string;
  outcomes?: BlueprintOutcome[];
};

export type AskQuestionInput = {
  questionId: string;
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  step?: { index: number; total: number };
  outcomeId?: string;
  role?: string;
};

export type AskQuestionOutput = {
  questionId: string;
  answerText: string;
  selectedOptionIds: string[];
  selectedValues: string[];
  otherText?: string;
  skipped?: boolean;
};

export type PickConnectorAppInput = {
  outcomeId: string;
  role: "trigger" | "source" | "destination";
  question?: string;
};

export type PickConnectorAppToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: PickConnectorAppInput;
  output?: AskQuestionOutput;
};

export type ConnectorDiscoveryOutput = {
  groups?: Array<{
    outcomeId: string;
    role: string;
    outcomeDescription: string;
    askOptions: InteractivePromptOption[];
    recommendedOptionIds: string[];
    defaultQuestion: string;
  }>;
};

export function uiMessagesEqual(a: UIMessage[], b: UIMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Content fingerprint — useChat may mutate the messages array in place without changing reference. */
export function getMessagesSyncKey(messages: UIMessage[]): string {
  return JSON.stringify(messages);
}

export function blueprintNeedsConnectorPick(spec: Record<string, unknown> | null): boolean {
  const blueprint = readTaskBlueprint(spec);
  if (!blueprint?.outcomes?.length) return true;
  return blueprint.outcomes.some(
    (outcome) => outcome.role !== "transform"
      && (outcome.status !== "chosen" || !outcome.selectedConnector)
      && outcome.status !== "skipped",
  );
}

export type PendingInteractivePrompt = {
  toolCallId: string;
  toolName: "askQuestion" | "pickConnectorApp";
  input: AskQuestionInput;
};

export const DEFAULT_CONNECTOR_PICK_QUESTION =
  "Which app should power this loop? Triggers and actions are configured automatically after you pick.";

export type PendingPresentReplyOptions = {
  toolCallId: string;
  input: PresentReplyOptionsInput;
};

export type ConfirmOutcomeBriefInput = {
  briefHash: string;
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowOther?: boolean;
};

export type ConfirmOutcomeBriefOutput = {
  action: "confirm" | "change_outcome" | "change_trigger" | "change_connectors" | "change_approvals" | "other";
  briefHash: string;
  answerText: string;
  selectedOptionIds: string[];
  selectedValues: string[];
  otherText?: string;
};

export type ConfirmOutcomeBriefToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: ConfirmOutcomeBriefInput;
  output?: ConfirmOutcomeBriefOutput;
};

export type PendingOutcomeBrief = {
  toolCallId: string;
  confirmBriefHash: string;
  confirmPrompt: Pick<ConfirmOutcomeBriefInput, "question" | "options" | "recommendedOptionIds" | "allowOther">;
};

export type PresentReplyOptionsToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: PresentReplyOptionsInput;
  output?: PresentReplyOptionsOutput;
};

export type AskQuestionToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: AskQuestionInput;
  output?: AskQuestionOutput;
};

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export function readTaskBlueprint(spec: Record<string, unknown> | null): TaskBlueprint | null {
  const blueprint = spec?.taskBlueprint;
  if (!blueprint || typeof blueprint !== "object") return null;
  return blueprint as TaskBlueprint;
}

export function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

export function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

export function isAskQuestionPart(part: { type: string; toolName?: string }): part is AskQuestionToolPart {
  return resolveToolPartName(part) === "askQuestion";
}

export function isPickConnectorAppPart(part: { type: string; toolName?: string }): part is PickConnectorAppToolPart {
  return resolveToolPartName(part) === "pickConnectorApp";
}

export function isPresentReplyOptionsPart(part: { type: string; toolName?: string }): part is PresentReplyOptionsToolPart {
  return resolveToolPartName(part) === "presentReplyOptions";
}

export function isConfirmOutcomeBriefPart(part: { type: string; toolName?: string }): part is ConfirmOutcomeBriefToolPart {
  return resolveToolPartName(part) === "confirmOutcomeBrief";
}

const CONDUCTOR_UI_ONLY_TOOLS = new Set([
  "askQuestion",
  "pickConnectorApp",
  "presentReplyOptions",
  "confirmOutcomeBrief",
]);

function hasQuestionOptionsInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const row = input as { question?: string; options?: unknown[] };
  return typeof row.question === "string"
    && row.question.trim().length > 0
    && Array.isArray(row.options)
    && row.options.length >= 2;
}

function hasPresentReplyOptionsInput(input: unknown): boolean {
  return Boolean(
    input
    && typeof input === "object"
    && Array.isArray((input as { options?: unknown[] }).options)
    && (input as { options?: unknown[] }).options!.length >= 2,
  );
}

function hasConfirmOutcomeBriefInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const row = input as { briefHash?: string };
  return typeof row.briefHash === "string"
    && row.briefHash.trim().length > 0
    && hasQuestionOptionsInput(input);
}

function hasPickConnectorAppInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const row = input as { outcomeId?: string };
  return typeof row.outcomeId === "string" && row.outcomeId.trim().length > 0;
}

function isResumableUiToolPart(
  toolName: string,
  state: string | undefined,
  input: unknown,
  output: unknown,
): boolean {
  if (!CONDUCTOR_UI_ONLY_TOOLS.has(toolName) || output != null) return false;
  if (state === "input-available") return true;
  if (state !== "input-streaming") return false;
  switch (toolName) {
    case "askQuestion":
      return hasQuestionOptionsInput(input);
    case "pickConnectorApp":
      return hasPickConnectorAppInput(input);
    case "presentReplyOptions":
      return hasPresentReplyOptionsInput(input);
    case "confirmOutcomeBrief":
      return hasConfirmOutcomeBriefInput(input);
    default:
      return false;
  }
}

export type StaleConfirmOutcomeBriefCall = {
  toolCallId: string;
  briefHash: string;
};

function isUnansweredUiToolPart(part: { type: string; toolName?: string; state?: string; output?: unknown }): boolean {
  if (!isToolPart(part.type)) return false;
  const toolName = resolveToolPartName(part);
  return isResumableUiToolPart(toolName, part.state, (part as { input?: unknown }).input, part.output);
}

/** Any UI-only tool call in the transcript still waiting for addToolOutput. */
export function hasUnansweredUiToolCalls(messages: UIMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (isUnansweredUiToolPart(part as { type: string; toolName?: string; state?: string; output?: unknown })) {
        return true;
      }
    }
  }
  return false;
}

/** Unanswered confirmOutcomeBrief calls superseded by a later reviewOutcomeBrief. */
export function findStaleConfirmOutcomeBriefCalls(messages: UIMessage[]): StaleConfirmOutcomeBriefCall[] {
  const stale: StaleConfirmOutcomeBriefCall[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j];
      if (!isConfirmOutcomeBriefPart(part)) continue;
      const toolPart = part as ConfirmOutcomeBriefToolPart;
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

export function shouldAutoSendConductorChat({
  messages,
}: {
  messages: UIMessage[];
}): boolean {
  if (hasUnansweredUiToolCalls(messages)) return false;
  return lastAssistantMessageIsCompleteWithToolCalls({ messages });
}

export function findPendingOutcomeBrief(messages: UIMessage[]): PendingOutcomeBrief | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!isConfirmOutcomeBriefPart(part)) continue;
      const toolPart = part as ConfirmOutcomeBriefToolPart;
      if (isResumableUiToolPart("confirmOutcomeBrief", toolPart.state, toolPart.input, toolPart.output)) {
        const confirmInput = toolPart.input;
        if (!confirmInput?.briefHash || !confirmInput.question || !confirmInput.options?.length) continue;
        return {
          toolCallId: toolPart.toolCallId,
          confirmBriefHash: confirmInput.briefHash,
          confirmPrompt: {
            question: confirmInput.question,
            options: confirmInput.options,
            recommendedOptionIds: confirmInput.recommendedOptionIds,
            allowOther: confirmInput.allowOther ?? true,
          },
        };
      }
    }
  }
  return null;
}

export function findLatestConnectorDiscovery(messages: UIMessage[]): ConnectorDiscoveryOutput | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!isToolPart(part.type)) continue;
      if (resolveToolPartName(part as { type: string; toolName?: string }) !== "discoverConnectorsForBlueprint") {
        continue;
      }
      const toolPart = part as DynamicToolUIPart & { output?: unknown };
      if (toolPart.state !== "output-available" || !toolPart.output) continue;
      const output = toolPart.output as ConnectorDiscoveryOutput;
      if (output.groups?.length) return output;
    }
  }
  return null;
}

export function buildConnectorPickInput(
  discovery: ConnectorDiscoveryOutput,
  outcomeId: string,
  questionOverride?: string,
): AskQuestionInput | null {
  const group = discovery.groups?.find((candidate) => candidate.outcomeId === outcomeId);
  if (!group?.askOptions.length) return null;
  const askOptions = group.askOptions;
  return {
    questionId: `connector-app:${group.outcomeId}`,
    question: questionOverride?.trim() || group.defaultQuestion || DEFAULT_CONNECTOR_PICK_QUESTION,
    options: askOptions,
    recommendedOptionIds: group.recommendedOptionIds ?? askOptions.slice(0, 5).map((option) => option.id),
    allowMultiple: false,
    allowOther: true,
    outcomeId: group.outcomeId,
    role: group.role,
  };
}

export function findPendingInteractivePrompt(
  messages: UIMessage[],
  spec: Record<string, unknown> | null = null,
): PendingInteractivePrompt | null {
  const discovery = findLatestConnectorDiscovery(messages);

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];

      if (isPickConnectorAppPart(part)) {
        const pickPart = part as PickConnectorAppToolPart;
        if (isResumableUiToolPart("pickConnectorApp", pickPart.state, pickPart.input, pickPart.output)) {
          if (!blueprintNeedsConnectorPick(spec) || !discovery || !pickPart.input?.outcomeId) continue;
          const input = buildConnectorPickInput(discovery, pickPart.input.outcomeId, pickPart.input.question);
          if (!input) continue;
          return {
            toolCallId: pickPart.toolCallId,
            toolName: "pickConnectorApp",
            input,
          };
        }
      }

      if (isAskQuestionPart(part)) {
        const askPart = part as AskQuestionToolPart;
        if (isResumableUiToolPart("askQuestion", askPart.state, askPart.input, askPart.output)) {
          const input = askPart.input;
          if (!input?.question || !input.options?.length) continue;

          return { toolCallId: askPart.toolCallId, toolName: "askQuestion", input };
        }
      }
    }
  }
  return null;
}

export function shouldShowThinkingIndicator(
  messages: UIMessage[],
  chatStatus: ChatStatus,
  hasPendingQuestion: boolean,
  forceThinking = false,
): boolean {
  if (forceThinking) return true;
  if (hasPendingQuestion) return false;
  if (chatStatus !== "streaming" && chatStatus !== "submitted") return false;

  const last = messages.at(-1);
  if (!last || last.role === "user") return true;

  const parts = last.parts ?? [];
  const hasStreamingReasoning = parts.some(
    (part) => part.type === "reasoning" && (part as ReasoningUIPart).state === "streaming",
  );
  if (hasStreamingReasoning) return false;

  const hasInProgressTool = parts.some((part) => {
    if (!isToolPart(part.type) || isAskQuestionPart(part)) return false;
    const state = (part as DynamicToolUIPart).state;
    return state !== "output-available" && state !== "output-error";
  });
  if (hasInProgressTool) return false;

  const hasVisibleText = parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
  if (hasVisibleText && chatStatus === "streaming") {
    const lastPart = parts.at(-1);
    if (lastPart && isToolPart(lastPart.type) && (lastPart as DynamicToolUIPart).state === "output-available") {
      return true;
    }
    return false;
  }

  return true;
}

export function makeUserMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

/**
 * useChat addToolOutput only patches the last message. Drop trailing user messages and
 * ensure the target tool part is on the final assistant message before applying output.
 */
export function prepareMessagesForUiToolOutput(
  messages: UIMessage[],
  toolCallId: string,
  output: unknown,
): UIMessage[] {
  const withOutput = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = (message.parts ?? []).map((part) => {
      const toolPart = part as DynamicToolUIPart & { toolCallId?: string };
      if (toolPart.toolCallId !== toolCallId) return part;
      changed = true;
      return {
        ...part,
        state: "output-available",
        output,
      } as UIMessage["parts"][number];
    });
    return changed ? { ...message, parts } : message;
  });

  const toolMessageIndex = withOutput.findIndex((message) =>
    message.role === "assistant"
    && (message.parts ?? []).some((part) => (part as { toolCallId?: string }).toolCallId === toolCallId),
  );
  if (toolMessageIndex < 0) return withOutput;
  return withOutput.slice(0, toolMessageIndex + 1);
}

export function outcomeRoleLabel(role: string): string {
  switch (role) {
    case "source": return "Source";
    case "destination": return "Destination";
    case "trigger": return "Trigger";
    case "transform": return "Transform";
    default: return role;
  }
}

export function promptVariantForQuestion(questionId: string): "connector" | "violet" | "amber" | "neutral" {
  if (questionId.startsWith("connector-app:")) return "connector";
  if (questionId === "knowledge-sources") return "violet";
  if (questionId === "review-gates") return "amber";
  return "neutral";
}
