import type { ConductorBuildPhase } from "./conductor-turn-budget.js";

export type PhaseHandoffMessagePart = {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
};

export type PhaseHandoffMessage = {
  role: string;
  parts?: PhaseHandoffMessagePart[];
};

export type PhaseHandoffProgress = {
  phase?: ConductorBuildPhase | string;
  goal?: string;
  completionCriteria?: string[];
  maxSteps?: number;
  autoAdvance?: boolean;
  handoffPending?: boolean;
  nextTool?: string | null;
  reason?: string;
  status?: "pending" | "in_progress" | "complete" | "waiting" | string;
  terminal?: boolean;
  pendingUiTool?: {
    toolCallId: string;
    toolName: string;
    input?: unknown;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function isSuccessfulToolOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const row = output as Record<string, unknown>;
  return row.ok !== false;
}

function hasUnansweredUiTool(messages: PhaseHandoffMessage[], toolName: string): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (resolveToolPartName(part) !== toolName) continue;
      if (part.state === "input-available" && part.output == null) return true;
    }
  }
  return false;
}

function hasSuccessfulTool(messages: PhaseHandoffMessage[], toolName: string): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (resolveToolPartName(part) !== toolName) continue;
      if (part.state !== "output-available" || !part.output) continue;
      if (isSuccessfulToolOutput(part.output)) return true;
    }
  }
  return false;
}

function lastToolOutput(messages: PhaseHandoffMessage[], toolName: string): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (let j = (message.parts ?? []).length - 1; j >= 0; j -= 1) {
      const part = message.parts![j]!;
      if (resolveToolPartName(part) !== toolName) continue;
      if (part.state !== "output-available" || !part.output || typeof part.output !== "object") continue;
      return part.output as Record<string, unknown>;
    }
  }
  return null;
}

function answeredQuestionIds(messages: PhaseHandoffMessage[]): Set<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (resolveToolPartName(part) !== "askQuestion") continue;
      if (part.state !== "output-available" || !part.output || typeof part.output !== "object") continue;
      const output = part.output as { questionId?: string; answerText?: string };
      const questionId = String(output.questionId ?? "").trim();
      const answer = String(output.answerText ?? "").trim();
      if (questionId && answer && answer !== "skipped") answered.add(questionId);
    }
  }
  return answered;
}

function deriveReviewHandoffPending(messages: PhaseHandoffMessage[]): boolean {
  if (hasUnansweredUiTool(messages, "confirmOutcomeBrief")) return false;
  const confirmed = messages.some((message) => message.role === "assistant" && (message.parts ?? []).some((part) => {
    if (resolveToolPartName(part) !== "confirmOutcomeBrief") return false;
    if (part.state !== "output-available" || !part.output || typeof part.output !== "object") return false;
    return (part.output as { action?: string }).action === "confirm";
  }));
  if (confirmed) return false;
  const roster = hasSuccessfulTool(messages, "presentAgentTeam")
    && messages.some((message) => message.role === "assistant" && (message.parts ?? []).some((part) => {
      if (resolveToolPartName(part) !== "presentAgentTeam") return false;
      if (part.state !== "output-available" || !part.output || typeof part.output !== "object") return false;
      const output = part.output as { specialists?: unknown[] };
      return Array.isArray(output.specialists) && output.specialists.length > 0;
    }));
  return roster;
}

function deriveConnectorHandoffPending(messages: PhaseHandoffMessage[]): boolean {
  if (hasUnansweredUiTool(messages, "pickConnectorApp")) return false;
  if (!hasSuccessfulTool(messages, "discoverConnectorsForBlueprint")) return false;
  const discovery = lastToolOutput(messages, "discoverConnectorsForBlueprint");
  const groups = Array.isArray(discovery?.groups) ? discovery!.groups : [];
  if (groups.length === 0) return false;
  const pickedOutcomes = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (resolveToolPartName(part) !== "pickConnectorApp") continue;
      if (part.state !== "output-available" || !part.output || typeof part.output !== "object") continue;
      const output = part.output as { outcomeId?: string; skipped?: boolean; selectedValues?: unknown[] };
      if (output.skipped === true) continue;
      const outcomeId = String(output.outcomeId ?? "").trim();
      if (outcomeId) pickedOutcomes.add(outcomeId);
    }
  }
  return groups.some((group) => {
    if (!group || typeof group !== "object") return false;
    const outcomeId = String((group as { outcomeId?: string }).outcomeId ?? "").trim();
    return outcomeId && !pickedOutcomes.has(outcomeId);
  });
}

function deriveBindingHandoffPending(messages: PhaseHandoffMessage[]): boolean {
  if (hasUnansweredUiTool(messages, "askQuestion")) return false;
  const resolveOutput = lastToolOutput(messages, "resolveBindings");
  const pendingQuestions = Array.isArray(resolveOutput?.pendingQuestions)
    ? resolveOutput!.pendingQuestions
    : [];
  if (pendingQuestions.length === 0) return false;
  const answered = answeredQuestionIds(messages);
  return pendingQuestions.some((question) => {
    if (!question || typeof question !== "object") return false;
    const questionId = String((question as { questionId?: string }).questionId ?? "").trim();
    return questionId && !answered.has(questionId);
  });
}

function deriveActivationHandoffPending(messages: PhaseHandoffMessage[]): boolean {
  if (hasUnansweredUiTool(messages, "presentReplyOptions")) return false;
  if (hasSuccessfulTool(messages, "activateLoop")) return false;
  return hasSuccessfulTool(messages, "presentReplyOptions")
    || completedPresentReplyWithoutActivate(messages);
}

function completedPresentReplyWithoutActivate(messages: PhaseHandoffMessage[]): boolean {
  const replied = messages.some((message) => message.role === "assistant" && (message.parts ?? []).some((part) => {
    if (resolveToolPartName(part) !== "presentReplyOptions") return false;
    return part.state === "output-available" && Boolean(part.output);
  }));
  if (!replied) return false;
  return !messages.some((message) => message.role === "assistant" && (message.parts ?? []).some((part) =>
    resolveToolPartName(part) === "activateLoop" && part.state === "output-available"));
}

function deriveIntentHandoffPending(messages: PhaseHandoffMessage[]): boolean {
  if (hasUnansweredUiTool(messages, "askQuestion")) return false;
  if (!hasSuccessfulTool(messages, "analyzeIntent")) return false;
  const analysisOutput = lastToolOutput(messages, "analyzeIntent");
  const rawAnalysis = analysisOutput?.analysis;
  const questions = Array.isArray(rawAnalysis) ? [] : (
    isRecord(rawAnalysis) && Array.isArray(rawAnalysis.questions)
      ? rawAnalysis.questions
      : []
  );
  if (questions.length === 0) return false;
  const answered = answeredQuestionIds(messages);
  return questions.some((question) => {
    if (!question || typeof question !== "object") return false;
    const questionId = String((question as { id?: string }).id ?? "").trim();
    return questionId && !answered.has(questionId);
  });
}

function deriveTranscriptHandoffPending(
  messages: PhaseHandoffMessage[],
  buildPhase?: ConductorBuildPhase | null,
): boolean {
  if (!buildPhase) return false;
  switch (buildPhase) {
    case "intent":
      return deriveIntentHandoffPending(messages);
    case "review":
      return deriveReviewHandoffPending(messages);
    case "connectors":
      return deriveConnectorHandoffPending(messages);
    case "bindings":
      return deriveBindingHandoffPending(messages);
    case "activation":
      return deriveActivationHandoffPending(messages);
    default:
      return false;
  }
}

/** Expected next tool not yet invoked; text-only bridge output should auto-continue. */
export function isPhaseHandoffPending(input: {
  messages: PhaseHandoffMessage[];
  buildPhase?: ConductorBuildPhase | null;
  phaseProgress?: PhaseHandoffProgress | null;
}): boolean {
  const pending = input.phaseProgress?.pendingUiTool;
  if (pending) {
    const answered = input.messages.some((message) => message.role === "assistant" && (message.parts ?? []).some((part) => {
      const partWithId = part as PhaseHandoffMessagePart & { toolCallId?: string };
      if (partWithId.toolCallId !== pending.toolCallId) return false;
      return part.state === "output-available" && part.output != null;
    }));
    if (!answered) return false;
  }
  if (input.phaseProgress?.handoffPending === true) return true;
  if (input.phaseProgress?.handoffPending === false) return false;
  return deriveTranscriptHandoffPending(input.messages, input.buildPhase);
}

/** @deprecated Use isPhaseHandoffPending */
export function isReviewConfirmationHandoffPending(input: {
  messages: PhaseHandoffMessage[];
  buildPhase?: ConductorBuildPhase | null;
}): boolean {
  return isPhaseHandoffPending(input);
}
