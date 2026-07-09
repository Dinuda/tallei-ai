import {
  type DynamicToolUIPart,
  type ReasoningUIPart,
  type UIMessage,
} from "ai";

import type {
  InteractivePromptAnswer,
  InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
import {
  resolveConfirmOutcomeBriefActionFromSelection,
  type ConfirmOutcomeBriefAction,
} from "@tallei/shared/confirm-outcome-brief-action";
import { findActivationReplyOption } from "@tallei/shared/conductor-activation-confirm";
import type {
  PresentReplyOptionsInput,
  PresentReplyOptionsOutput,
} from "@/lib/conductor-prompt-suggestions";
import { CONDUCTOR_UI_ONLY_TOOLS } from "@tallei/conductor-tools/tool-names";
import {
  CONDUCTOR_BUDGET_EXHAUSTED_QUESTION,
  type ConductorBuildPhase,
} from "@tallei/shared/conductor-turn-budget";
import type { PhaseHandoffProgress } from "@tallei/shared/conductor-phase-handoff";

export type { PhaseHandoffProgress };

export type ConductorToolResultStatus = "failed" | "blocked" | "recovering" | undefined;

export function resolveConductorToolResultStatus(output: unknown): ConductorToolResultStatus {
  if (!output || typeof output !== "object") return undefined;
  const execution = output as { ok?: boolean; turnOutcome?: string; recoveryPhase?: string };
  if (execution.recoveryPhase) return "recovering";
  if (execution.ok !== false) return undefined;
  return execution.turnOutcome === "blocked" ? "blocked" : "failed";
}

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

/** Multiple askQuestion prompts in one turn — answers are batched client-side before POST. */
export function isBatchableAskQuestionPrompts(prompts: PendingInteractivePrompt[]): boolean {
  return prompts.length > 1 && prompts.every((prompt) => prompt.toolName === "askQuestion");
}

export function partitionPendingQuestionBatch(
  prompts: PendingInteractivePrompt[],
  queuedAnswers: ReadonlyMap<string, InteractivePromptAnswer>,
): {
  batchMode: boolean;
  total: number;
  queuedCount: number;
  remaining: PendingInteractivePrompt[];
} {
  const batchMode = isBatchableAskQuestionPrompts(prompts);
  const total = prompts.length;
  if (!batchMode) {
    return { batchMode: false, total, queuedCount: 0, remaining: prompts };
  }

  const remainingBase = prompts.filter((prompt) => !queuedAnswers.has(prompt.toolCallId));
  const queuedCount = total - remainingBase.length;
  const remaining = remainingBase.map((prompt, index) => ({
    ...prompt,
    input: {
      ...prompt.input,
      step: { index: queuedCount + index + 1, total },
    },
  }));

  return { batchMode: true, total, queuedCount, remaining };
}

export const DEFAULT_CONNECTOR_PICK_QUESTION =
  "Which app should handle this workflow step?";

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
  action: ConfirmOutcomeBriefAction;
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

export type AgentTeamSpecialistStep = {
  outcomeId: string;
  role: "trigger" | "source" | "transform" | "destination";
  description: string;
  connector?: string;
};

export type AgentTeamSpecialist = {
  id: string;
  name: string;
  roleTitle: string;
  description: string;
  avatarSeed: string;
  ownershipSummary: string;
  steps: AgentTeamSpecialistStep[];
};

export type AgentTeamReviewer = {
  roleTitle: string;
  description: string;
};

export type AgentTeamTrigger = {
  outcomeId: string;
  description: string;
  connector?: string;
};

export type PresentAgentTeamOutput = {
  title: string;
  triggers?: AgentTeamTrigger[];
  specialists: AgentTeamSpecialist[];
  reviewer?: AgentTeamReviewer;
  reviewerInsertIndex?: number;
  fallbackApplied?: boolean;
};

export type PresentAgentTeamToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: { groups?: Array<{ outcomeIds: string[]; roleTitle?: string; ownershipSummary?: string }> };
  output?: PresentAgentTeamOutput;
};

export type AskQuestionToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: AskQuestionInput;
  output?: AskQuestionOutput;
};

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

function isBudgetExhaustedEnding(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  for (const part of last.parts ?? []) {
    if (!isToolPart(part.type)) continue;
    const toolPart = part as DynamicToolUIPart & { output?: unknown };
    if (toolPart.state !== "output-available" || !toolPart.output || typeof toolPart.output !== "object") continue;
    if ((toolPart.output as { turnOutcome?: string }).turnOutcome === "budget_exhausted") return true;
  }
  return (last.parts ?? []).some((part) =>
    part.type === "text"
    && part.text.includes(CONDUCTOR_BUDGET_EXHAUSTED_QUESTION.slice(0, 48)));
}

export function isConductorBudgetExhausted(messages: UIMessage[]): boolean {
  return isBudgetExhaustedEnding(messages);
}

export type { ConductorBuildPhase };

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

export function isPresentAgentTeamPart(part: { type: string; toolName?: string }): part is PresentAgentTeamToolPart {
  return resolveToolPartName(part) === "presentAgentTeam";
}

export function findLatestPresentAgentTeamOutput(messages: UIMessage[]): PresentAgentTeamOutput | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const parts = message?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (!part || !isPresentAgentTeamPart(part as { type: string; toolName?: string })) continue;
      const toolPart = part as PresentAgentTeamToolPart;
      if (toolPart.state !== "output-available" || !toolPart.output?.specialists?.length) continue;
      return toolPart.output;
    }
  }
  return null;
}

export function isConfirmOutcomeBriefPart(part: { type: string; toolName?: string }): part is ConfirmOutcomeBriefToolPart {
  return resolveToolPartName(part) === "confirmOutcomeBrief";
}

function hasQuestionOptionsInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const row = input as { questionId?: string; question?: string; options?: unknown[] };
  return typeof row.questionId === "string"
    && row.questionId.trim().length > 0
    && typeof row.question === "string"
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
  const row = input as { briefHash?: string; question?: string; options?: unknown[] };
  return typeof row.briefHash === "string"
    && row.briefHash.trim().length > 0
    && typeof row.question === "string"
    && row.question.trim().length > 0
    && Array.isArray(row.options)
    && row.options.length >= 2;
}

function hasPickConnectorAppInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const row = input as { outcomeId?: string };
  return typeof row.outcomeId === "string" && row.outcomeId.trim().length > 0;
}

function hasResumableUiToolInput(toolName: string, input: unknown): boolean {
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
      return true;
  }
}

function isResumableUiToolPart(
  toolName: string,
  state: string | undefined,
  input: unknown,
  output: unknown,
): boolean {
  if (!CONDUCTOR_UI_ONLY_TOOLS.has(toolName) || output != null) return false;
  if (state === "input-available") return hasResumableUiToolInput(toolName, input);
  if (state !== "input-streaming") return false;
  return hasResumableUiToolInput(toolName, input);
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

function isPhaseProgressPendingUiToolAnswered(
  messages: UIMessage[],
  pending: NonNullable<PhaseHandoffProgress["pendingUiTool"]>,
): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (!isToolPart(part.type)) continue;
      const toolPart = part as DynamicToolUIPart & { output?: unknown };
      if (toolPart.toolCallId !== pending.toolCallId) continue;
      return toolPart.state === "output-available" && toolPart.output != null;
    }
  }
  return false;
}


function pendingOutcomeBriefFromPhaseProgress(
  messages: UIMessage[],
  phaseProgress?: PhaseHandoffProgress | null,
): PendingOutcomeBrief | null {
  const pending = phaseProgress?.pendingUiTool;
  if (!pending || pending.toolName !== "confirmOutcomeBrief") return null;
  if (isPhaseProgressPendingUiToolAnswered(messages, pending)) return null;
  const input = pending.input as ConfirmOutcomeBriefInput | undefined;
  if (!input?.briefHash || !input.question || !input.options?.length) return null;
  return {
    toolCallId: pending.toolCallId,
    confirmBriefHash: input.briefHash,
    confirmPrompt: {
      question: input.question,
      options: input.options,
      recommendedOptionIds: input.recommendedOptionIds,
      allowOther: false,
    },
  };
}

/** Revision for client persistence dedupe; ignores streaming reasoning token deltas. */
export function messagesPersistenceRevision(messages: UIMessage[]): string {
  return messages.map((message) => {
    const parts = (message.parts ?? []).map((part) => {
      if (part.type === "text") {
        return `t:${part.text?.length ?? 0}`;
      }
      if (part.type === "reasoning") {
        const reasoning = part as ReasoningUIPart;
        if (reasoning.state === "streaming") return "r:streaming";
        return `r:${reasoning.state ?? "done"}:${reasoning.text?.length ?? 0}`;
      }
      if (isToolPart(part.type)) {
        const toolPart = part as DynamicToolUIPart & { output?: unknown };
        return `tool:${toolPart.toolCallId ?? ""}:${toolPart.state ?? ""}:${toolPart.output != null ? 1 : 0}`;
      }
      return part.type;
    }).join(",");
    return `${message.id}:${parts}`;
  }).join("|");
}

/** Fingerprint tool part states so effects can react to tool answers without message count changes. */
export function messagesUiStateRevision(messages: UIMessage[]): string {
  return messages.map((message) => {
    const toolStates = (message.parts ?? [])
      .filter((part) => isToolPart(part.type))
      .map((part) => {
        const toolPart = part as DynamicToolUIPart & { output?: unknown };
        return `${toolPart.toolCallId ?? ""}:${toolPart.state ?? ""}:${toolPart.output != null ? 1 : 0}`;
      })
      .join(",");
    return `${message.id}:${toolStates}`;
  }).join("|");
}

/** Lightweight per-message revision for memoizing frozen transcript turns. */
export function messagePartsRevision(message: UIMessage): string {
  return (message.parts ?? []).map((part) => {
    if (part.type === "text") {
      return `t:${part.text?.length ?? 0}`;
    }
    if (part.type === "reasoning") {
      const reasoning = part as { state?: string; text?: string };
      return `r:${reasoning.state ?? ""}:${reasoning.text?.length ?? 0}`;
    }
    if (isToolPart(part.type)) {
      const toolPart = part as DynamicToolUIPart & { output?: unknown };
      return `tool:${toolPart.toolCallId ?? ""}:${toolPart.state ?? ""}:${toolPart.output != null ? 1 : 0}`;
    }
    return part.type;
  }).join("|");
}

/** Any UI-only tool call in the transcript still waiting for a tool-answer. */
export function hasUnansweredUiToolCalls(
  messages: UIMessage[],
  phaseProgress?: PhaseHandoffProgress | null,
  excludeToolCallIds: ReadonlySet<string> = new Set(),
): boolean {
  if (phaseProgress?.pendingUiTool
    && !excludeToolCallIds.has(phaseProgress.pendingUiTool.toolCallId)
    && !isPhaseProgressPendingUiToolAnswered(messages, phaseProgress.pendingUiTool)) {
    return true;
  }
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      const toolPart = part as { type: string; toolName?: string; state?: string; output?: unknown; toolCallId?: string };
      if (toolPart.toolCallId && excludeToolCallIds.has(toolPart.toolCallId)) continue;
      if (isUnansweredUiToolPart(toolPart)) {
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



export function findPendingOutcomeBrief(
  messages: UIMessage[],
  phaseProgress?: PhaseHandoffProgress | null,
  excludeToolCallIds: ReadonlySet<string> = new Set(),
): PendingOutcomeBrief | null {
  const fromProgress = pendingOutcomeBriefFromPhaseProgress(messages, phaseProgress);
  if (fromProgress && !excludeToolCallIds.has(fromProgress.toolCallId)) return fromProgress;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!isConfirmOutcomeBriefPart(part)) continue;
      const toolPart = part as ConfirmOutcomeBriefToolPart;
      if (excludeToolCallIds.has(toolPart.toolCallId)) continue;
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
            allowOther: false,
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
): AskQuestionInput | null {
  const group = discovery.groups?.find((candidate) => candidate.outcomeId === outcomeId);
  if (!group?.askOptions.length) return null;
  const askOptions = group.askOptions;
  return {
    questionId: `connector-app:${group.outcomeId}`,
    question: group.defaultQuestion || DEFAULT_CONNECTOR_PICK_QUESTION,
    options: askOptions,
    recommendedOptionIds: group.recommendedOptionIds ?? askOptions.slice(0, 5).map((option) => option.id),
    allowMultiple: false,
    // Discovery already returns the searchable connector catalogue. Free text
    // would bypass the server-ranked capability set and cannot be validated as
    // a real connector selection.
    allowOther: false,
    outcomeId: group.outcomeId,
    role: group.role,
  };
}

/** Discovery + options shown when the user answered a connector pick earlier in the transcript. */
export function findConnectorPickInputForToolCall(
  messages: UIMessage[],
  toolCallId: string,
  outcomeId: string,
): AskQuestionInput | null {
  let latestDiscovery: ConnectorDiscoveryOutput | null = null;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (isPickConnectorAppPart(part)) {
        const pickPart = part as PickConnectorAppToolPart;
        if (pickPart.toolCallId === toolCallId) {
          return latestDiscovery
            ? buildConnectorPickInput(latestDiscovery, outcomeId)
            : null;
        }
      }
      if (!isToolPart(part.type)) continue;
      if (resolveToolPartName(part as { type: string; toolName?: string }) !== "discoverConnectorsForBlueprint") {
        continue;
      }
      const toolPart = part as DynamicToolUIPart & { output?: unknown };
      if (toolPart.state !== "output-available" || !toolPart.output) continue;
      const output = toolPart.output as ConnectorDiscoveryOutput;
      if (output.groups?.length) latestDiscovery = output;
    }
  }

  return null;
}

/** Hide earlier answered askQuestion cards when the same questionId was answered again. */
export function collectSupersededAskQuestionCallIds(messages: UIMessage[]): Set<string> {
  const latestByQuestionId = new Map<string, string>();
  const superseded = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (!isAskQuestionPart(part)) continue;
      const askPart = part as AskQuestionToolPart;
      const questionId = askPart.input?.questionId?.trim();
      if (!questionId || askPart.state !== "output-available" || askPart.output == null) continue;
      const previous = latestByQuestionId.get(questionId);
      if (previous) superseded.add(previous);
      latestByQuestionId.set(questionId, askPart.toolCallId);
    }
  }

  return superseded;
}

export function clearPhaseProgressPendingUiTool(
  phaseProgress: PhaseHandoffProgress | null | undefined,
  toolCallId: string,
): PhaseHandoffProgress | null | undefined {
  if (!phaseProgress?.pendingUiTool) return phaseProgress;
  if (phaseProgress.pendingUiTool.toolCallId !== toolCallId) return phaseProgress;
  return { ...phaseProgress, pendingUiTool: undefined };
}

export function findPendingInteractivePrompts(
  messages: UIMessage[],
  spec: Record<string, unknown> | null = null,
  phaseProgress?: PhaseHandoffProgress | null,
  excludeToolCallIds: ReadonlySet<string> = new Set(),
): PendingInteractivePrompt[] {
  const discovery = findLatestConnectorDiscovery(messages);
  const prompts: PendingInteractivePrompt[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j];

      if (isPickConnectorAppPart(part)) {
        const pickPart = part as PickConnectorAppToolPart;
        if (isResumableUiToolPart("pickConnectorApp", pickPart.state, pickPart.input, pickPart.output)) {
          if (!blueprintNeedsConnectorPick(spec) || !discovery || !pickPart.input?.outcomeId) continue;
          const input = buildConnectorPickInput(discovery, pickPart.input.outcomeId);
          if (!input) continue;
          prompts.push({
            toolCallId: pickPart.toolCallId,
            toolName: "pickConnectorApp",
            input,
          });
        }
      }

      if (isAskQuestionPart(part)) {
        const askPart = part as AskQuestionToolPart;
        if (isResumableUiToolPart("askQuestion", askPart.state, askPart.input, askPart.output)) {
          const input = askPart.input;
          if (!input || !hasQuestionOptionsInput(input)) continue;
          prompts.push({ toolCallId: askPart.toolCallId, toolName: "askQuestion", input });
        }
      }
    }
  }

  const persistedPending = phaseProgress?.pendingUiTool;
  if (persistedPending
    && !excludeToolCallIds.has(persistedPending.toolCallId)
    && !prompts.some((prompt) => prompt.toolCallId === persistedPending.toolCallId)
    && !isPhaseProgressPendingUiToolAnswered(messages, persistedPending)) {
    if (persistedPending.toolName === "askQuestion"
      && hasQuestionOptionsInput(persistedPending.input)) {
      prompts.push({
        toolCallId: persistedPending.toolCallId,
        toolName: "askQuestion",
        input: persistedPending.input as AskQuestionInput,
      });
    } else if (discovery
      && persistedPending.toolName === "pickConnectorApp"
      && hasPickConnectorAppInput(persistedPending.input)) {
      const input = buildConnectorPickInput(
        discovery,
        (persistedPending.input as PickConnectorAppInput).outcomeId,
      );
      if (input) {
        prompts.push({
          toolCallId: persistedPending.toolCallId,
          toolName: "pickConnectorApp",
          input,
        });
      }
    }
  }

  const visible = excludeToolCallIds.size > 0
    ? prompts.filter((prompt) => !excludeToolCallIds.has(prompt.toolCallId))
    : prompts;

  if (visible.length <= 1) return visible;

  return visible.map((prompt, index) => ({
    ...prompt,
    input: {
      ...prompt.input,
      step: { index: index + 1, total: visible.length },
    },
  }));
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


export function outcomeRoleLabel(role: string): string {
  switch (role) {
    case "source": return "Source";
    case "destination": return "Destination";
    case "trigger": return "Trigger";
    case "transform": return "Transform";
    default: return role;
  }
}

export function promptVariantForQuestion(questionId: string | undefined): "connector" | "violet" | "amber" | "neutral" {
  if (!questionId) return "neutral";
  if (questionId.startsWith("connector-app:")) return "connector";
  if (questionId === "knowledge-sources") return "violet";
  if (questionId === "review-gates") return "amber";
  return "neutral";
}

export { resolveConfirmOutcomeBriefActionFromSelection };

function isContinueLikeComposerMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ["continue", "yes", "okay", "ok", "go ahead", "proceed", "sure"].includes(normalized);
}

/** Route stall/continue chips to an open event-log pending UI tool when possible. */
export function tryResolveContinueAsPendingUiToolAnswer(
  text: string,
  phaseProgress?: PhaseHandoffProgress | null,
): { tool: string; toolCallId: string; output: Record<string, unknown> } | null {
  const pending = phaseProgress?.pendingUiTool;
  if (!pending || !isContinueLikeComposerMessage(text)) return null;
  if (pending.toolName === "confirmOutcomeBrief") {
    const input = pending.input as ConfirmOutcomeBriefInput | undefined;
    const confirmOption = input?.options?.find((option) => option.value === "confirm" || option.id === "confirm");
    if (!input?.briefHash || !confirmOption) return null;
    return {
      tool: "confirmOutcomeBrief",
      toolCallId: pending.toolCallId,
      output: {
        action: "confirm" as ConfirmOutcomeBriefAction,
        briefHash: input.briefHash,
        answerText: text.trim(),
        selectedOptionIds: [confirmOption.id],
        selectedValues: [confirmOption.value],
      },
    };
  }
  if (pending.toolName === "presentReplyOptions") {
    const activateOption = findActivationReplyOption(pending.input);
    if (!activateOption) return null;
    return {
      tool: "presentReplyOptions",
      toolCallId: pending.toolCallId,
      output: {
        selectedOptionId: activateOption.id,
        message: activateOption.message || text.trim(),
      },
    };
  }
  return null;
}

export function connectorLogoUrl(slug: string): string {
  return `https://logos.composio.dev/api/${slug}`;
}

export function formatConnectorLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return trimmed;
}

function formatAskQuestionAnswerLabels(labels: string[]): string {
  return labels.map(formatConnectorLabel).join("; ");
}

export function resolveAskQuestionDisplayAnswer(
  input: Pick<AskQuestionInput, "options"> | undefined,
  output: AskQuestionOutput,
): string {
  if (output.skipped) return "Skipped";

  const selectedLabels = (output.selectedOptionIds ?? [])
    .map((id) => input?.options?.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  if (selectedLabels.length > 0) {
    const custom = output.otherText?.trim();
    return formatAskQuestionAnswerLabels([
      ...selectedLabels,
      ...(custom ? [custom] : []),
    ]);
  }

  const valueLabels = (output.selectedValues ?? [])
    .map((value) => input?.options?.find((option) => option.value === value)?.label ?? value)
    .filter((label) => label.length > 0);
  if (valueLabels.length > 0) {
    const custom = output.otherText?.trim();
    return formatAskQuestionAnswerLabels([
      ...valueLabels,
      ...(custom ? [custom] : []),
    ]);
  }

  const fallback = output.otherText?.trim() || output.answerText;
  return formatConnectorLabel(fallback);
}

/** Matches POST /api/loops prompt validation. */
export const CONDUCTOR_MESSAGE_MAX_LENGTH = 4_000;

export function validateConductorComposerMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Message cannot be empty.";
  if (trimmed.length > CONDUCTOR_MESSAGE_MAX_LENGTH) {
    return `Message is too long (${trimmed.length.toLocaleString()} / ${CONDUCTOR_MESSAGE_MAX_LENGTH.toLocaleString()} characters).`;
  }
  return null;
}

export function resolveConnectorIconSlug(
  output: Pick<AskQuestionOutput, "selectedOptionIds" | "selectedValues">,
  options?: InteractivePromptOption[],
): string | undefined {
  for (const id of output.selectedOptionIds ?? []) {
    const icon = options?.find((option) => option.id === id)?.icon;
    if (icon) return icon;
  }

  for (const value of output.selectedValues ?? []) {
    const matched = options?.find((option) => option.value === value || option.id === value);
    if (matched?.icon) return matched.icon;
    if (value) return value.toLowerCase();
  }

  for (const id of output.selectedOptionIds ?? []) {
    if (id) return id.toLowerCase();
  }

  return undefined;
}

export function resolveOutcomeBriefCardStatus(input: {
  output?: ConfirmOutcomeBriefOutput;
  options?: InteractivePromptOption[];
  streaming?: boolean;
  awaitingInput?: boolean;
}): "pending" | "confirmed" | "change-requested" | undefined {
  if (input.streaming) return "pending";
  if (input.awaitingInput) return "pending";

  const action = input.output
    ? resolveConfirmOutcomeBriefActionFromSelection({
        selectedOptionIds: input.output.selectedOptionIds,
        selectedValues: input.output.selectedValues,
        options: input.options ?? [],
      })
    : null;

  if (!action) return undefined;
  return action === "confirm" ? "confirmed" : "change-requested";
}
