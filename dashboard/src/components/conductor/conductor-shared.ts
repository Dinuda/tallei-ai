import {
  lastAssistantMessageIsCompleteWithToolCalls,
  type DynamicToolUIPart,
  type ReasoningUIPart,
  type UIMessage,
} from "ai";

import type { InteractivePromptOption } from "@/components/ai-elements/interactive-prompt-menu";
import {
  resolveConfirmOutcomeBriefActionFromSelection,
  type ConfirmOutcomeBriefAction,
} from "@/lib/confirm-outcome-brief-action";
import { findActivationReplyOption } from "@/lib/conductor-activation-confirm";
import {
  isBuildTerminalForStall,
  isPhaseOpenForStallRecovery,
} from "@/lib/conductor-stall-recovery";
import type {
  PresentReplyOptionsInput,
  PresentReplyOptionsOutput,
} from "@/lib/conductor-prompt-suggestions";
import {
  CONDUCTOR_BUDGET_EXHAUSTED_QUESTION,
  isActionableConductorPhase,
  isRecoverableConductorExecution,
  type ConductorBuildPhase,
  type ConductorStallResult,
} from "@/lib/conductor-turn-budget";
import { isPhaseHandoffPending, type PhaseHandoffProgress } from "@/lib/conductor-phase-handoff";

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

export type ConductorToolExecution = {
  ok: boolean;
  operationKey: string;
  parentArtifactHash: string;
  phaseCompleted: boolean;
  requiresUserInput: boolean;
  retryAllowed: boolean;
  turnOutcome?: string;
  continuation?: string;
  recoverToPhase?: string;
  nextPhase?: string;
  handoffId?: string;
  compiledPlanId?: string;
};

function readExecutionFromOutput(output: Record<string, unknown>): ConductorToolExecution | null {
  const operationKey = typeof output.operationKey === "string" ? output.operationKey : null;
  const parentArtifactHash = typeof output.parentArtifactHash === "string" ? output.parentArtifactHash : null;
  if (!operationKey || !parentArtifactHash) return null;
  return {
    ok: output.ok === false ? false : true,
    operationKey,
    parentArtifactHash,
    phaseCompleted: output.phaseCompleted === true,
    requiresUserInput: output.requiresUserInput === true,
    retryAllowed: output.retryAllowed === true,
    ...(typeof output.turnOutcome === "string" ? { turnOutcome: output.turnOutcome } : {}),
    ...(typeof output.continuation === "string" ? { continuation: output.continuation } : {}),
    ...(typeof output.recoverToPhase === "string" ? { recoverToPhase: output.recoverToPhase } : {}),
    ...(typeof output.nextPhase === "string" ? { nextPhase: output.nextPhase } : {}),
    ...(typeof output.handoffId === "string" ? { handoffId: output.handoffId } : {}),
    ...(typeof output.compiledPlanId === "string" ? { compiledPlanId: output.compiledPlanId } : {}),
  };
}

function getLastAssistantExecutions(messages: UIMessage[]): ConductorToolExecution[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return [];
  return (last.parts ?? []).flatMap((part) => {
    if (!isToolPart(part.type)) return [];
    const toolPart = part as DynamicToolUIPart & { output?: unknown };
    if (toolPart.state !== "output-available" || !toolPart.output || typeof toolPart.output !== "object") return [];
    const parsed = readExecutionFromOutput(toolPart.output as Record<string, unknown>);
    return parsed ? [parsed] : [];
  });
}

export { isBuildTerminalForStall } from "@/lib/conductor-stall-recovery";

export function findPendingConductorPhaseHandoff(messages: UIMessage[]): ConductorToolExecution | null {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return null;
  const executions = getLastAssistantExecutions(messages);
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index]!;
    if ((execution.continuation === "next_phase" || execution.continuation === "continue_phase")
      && (execution.turnOutcome === "phase_complete" || execution.turnOutcome === "progress")
      && execution.nextPhase
      && execution.handoffId
      && !hasPriorTerminalExecutionForOperation(messages, execution.operationKey, execution.parentArtifactHash)) {
      return execution;
    }
  }
  return null;
}

function hasTerminalExecution(executions: ConductorToolExecution[]): boolean {
  return executions.some((execution) => {
    if (execution.turnOutcome === "build_complete") return true;
    const output = {
      ok: execution.ok,
      retryAllowed: execution.retryAllowed,
      recoverToPhase: execution.recoverToPhase,
    };
    if (isRecoverableConductorExecution(output)) return false;
    return execution.phaseCompleted
      || execution.requiresUserInput
      || (!execution.ok && !execution.retryAllowed);
  });
}

function lastAssistantIsTextOnly(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  const parts = last.parts ?? [];
  const hasText = parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  const hasToolOutput = parts.some((part) =>
    isToolPart(part.type) && (part as DynamicToolUIPart).state === "output-available");
  return hasText && !hasToolOutput;
}

function isBudgetExhaustedEnding(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  const executions = getLastAssistantExecutions(messages);
  if (executions.some((execution) => execution.turnOutcome === "budget_exhausted")) return true;
  return (last.parts ?? []).some((part) =>
    part.type === "text"
    && part.text.includes(CONDUCTOR_BUDGET_EXHAUSTED_QUESTION.slice(0, 48)));
}

export function findConductorStall(input: {
  messages: UIMessage[];
  buildPhase: ConductorBuildPhase | null | undefined;
  missingSlots: string[];
  chatBusy: boolean;
  loopStatus?: string;
  phaseProgress?: PhaseHandoffProgress | null;
}): ConductorStallResult {
  void input;
  return { stalled: false };
}

export function isConductorBudgetExhausted(messages: UIMessage[]): boolean {
  return isBudgetExhaustedEnding(messages);
}

export { isPhaseHandoffPending, isReviewConfirmationHandoffPending } from "@/lib/conductor-phase-handoff";

export { isActionableConductorPhase, type ConductorBuildPhase, type ConductorStallResult };

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

function lastAssistantEndedWithAnsweredUiTool(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  const allParts = last.parts ?? [];
  const lastStepStartIndex = allParts.reduce(
    (lastIndex, part, index) => part.type === "step-start" ? index : lastIndex,
    -1,
  );
  const parts = allParts.slice(lastStepStartIndex + 1);
  const toolParts = parts.filter((part) => isToolPart(part.type));
  if (toolParts.length === 0) return false;
  if (toolParts.some((part) => isUnansweredUiToolPart(part as { type: string; toolName?: string; state?: string; output?: unknown }))) {
    return false;
  }
  const allToolsFinished = toolParts.every((part) => {
    const toolPart = part as DynamicToolUIPart & { output?: unknown };
    return (toolPart.state === "output-available" && toolPart.output != null)
      || toolPart.state === "output-error";
  });
  if (!allToolsFinished) return false;
  const lastToolPart = toolParts.at(-1)!;
  const lastToolName = resolveToolPartName(lastToolPart as { type: string; toolName?: string });
  if (!CONDUCTOR_UI_ONLY_TOOLS.has(lastToolName)) return false;
  return toolParts.some((part) => {
    const toolName = resolveToolPartName(part as { type: string; toolName?: string });
    if (!CONDUCTOR_UI_ONLY_TOOLS.has(toolName)) return false;
    const toolPart = part as DynamicToolUIPart & { output?: unknown };
    return toolPart.state === "output-available" && toolPart.output != null;
  });
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

/** Fingerprint tool part states so effects can react to addToolOutput without message count changes. */
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

/** Any UI-only tool call in the transcript still waiting for addToolOutput. */
export function hasUnansweredUiToolCalls(
  messages: UIMessage[],
  phaseProgress?: PhaseHandoffProgress | null,
): boolean {
  if (phaseProgress?.pendingUiTool
    && !isPhaseProgressPendingUiToolAnswered(messages, phaseProgress.pendingUiTool)) {
    return true;
  }
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
  buildPhase,
  missingSlots = [],
  loopStatus,
  phaseProgress,
}: {
  messages: UIMessage[];
  buildPhase?: ConductorBuildPhase | null;
  missingSlots?: string[];
  loopStatus?: string;
  phaseProgress?: PhaseHandoffProgress | null;
}): boolean {
  if (hasUnansweredUiToolCalls(messages, phaseProgress)) return false;
  if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false;
  void buildPhase;
  void missingSlots;
  void loopStatus;
  return lastAssistantEndedWithAnsweredUiTool(messages);
}

function hasPriorTerminalExecutionForOperation(
  messages: UIMessage[],
  operationKey: string,
  parentArtifactHash: string,
): boolean {
  for (let i = 0; i < messages.length - 1; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (!isToolPart(part.type)) continue;
      const toolPart = part as DynamicToolUIPart & { output?: unknown };
      if (toolPart.state !== "output-available" || !toolPart.output || typeof toolPart.output !== "object") continue;
      const output = toolPart.output as Record<string, unknown>;
      if (output.operationKey !== operationKey || output.parentArtifactHash !== parentArtifactHash) continue;
      if (isRecoverableConductorExecution(output)) continue;
      const ok = output.ok === false ? false : true;
      const phaseCompleted = output.phaseCompleted === true;
      const requiresUserInput = output.requiresUserInput === true;
      const retryAllowed = output.retryAllowed === true;
      if (phaseCompleted || requiresUserInput || (!ok && !retryAllowed)) {
        return true;
      }
    }
  }
  return false;
}

export function findPendingOutcomeBrief(
  messages: UIMessage[],
  phaseProgress?: PhaseHandoffProgress | null,
): PendingOutcomeBrief | null {
  const fromProgress = pendingOutcomeBriefFromPhaseProgress(messages, phaseProgress);
  if (fromProgress) return fromProgress;
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

export function findPendingInteractivePrompts(
  messages: UIMessage[],
  spec: Record<string, unknown> | null = null,
  phaseProgress?: PhaseHandoffProgress | null,
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

  if (prompts.length <= 1) return prompts;

  return prompts.map((prompt, index) => ({
    ...prompt,
    input: {
      ...prompt.input,
      step: { index: index + 1, total: prompts.length },
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
