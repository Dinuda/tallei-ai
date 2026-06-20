import { getToolName, isToolUIPart, type UIMessage } from "ai";

import type { AgentPersonaUi } from "@/components/agent-persona/agent-persona";
import type { DataAgentPartData } from "@/components/ai-elements/transcript-message";

import {
  formatAgentStructuredOutput,
  formatInteractionDecision,
  formatStepOutput,
  latestAttemptPerStep,
  resolveStepDisplayText,
  type SpecRunInteraction,
  type SpecRunStep,
} from "./spec-run-view-utils";

const HIDDEN_CONTROL_TEXTS = new Set(["continue", "resume", "run", "rerun"]);
const GATE_TOOL_NAMES = new Set(["requestReview", "requestApproval", "requestInput"]);
const FINALIZE_TOOL_NAME = "finalizeAgent";

export function readMessageText(message: UIMessage): string {
  const part = message.parts.find((entry) => entry.type === "text");
  return part && part.type === "text" ? part.text.trim() : "";
}

export function isHiddenControlMessage(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  return HIDDEN_CONTROL_TEXTS.has(readMessageText(message).toLowerCase());
}

export function hasSubstantiveAssistantMessages(messages: UIMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    return message.parts.some((part) => {
      if (part.type === "data-agent") return true;
      if (part.type === "text" && part.text.trim()) return true;
      if (part.type.startsWith("tool-") || part.type === "dynamic-tool") return true;
      return false;
    });
  });
}

function readPersona(snapshot: SpecRunStep["agent_snapshot"]): AgentPersonaUi | undefined {
  const persona = snapshot.persona;
  if (!persona?.displayName) return undefined;
  return persona;
}

function stepPhase(step: SpecRunStep): DataAgentPartData["phase"] {
  if (step.status === "succeeded") return "finished";
  if (step.status === "failed" || step.status === "cancelled") return "failed";
  if (step.status === "running") return "working";
  if (step.status === "waiting_for_interaction") return "working";
  return "queued";
}

function isDataAgentPart(
  part: UIMessage["parts"][number],
): part is { type: "data-agent"; data: DataAgentPartData } {
  return part.type === "data-agent"
    && "data" in part
    && part.data !== null
    && typeof part.data === "object"
    && !Array.isArray(part.data);
}

export function readFinalizeAgentOutput(part: UIMessage["parts"][number]): string {
  if (!isToolUIPart(part) || getToolName(part) !== FINALIZE_TOOL_NAME) return "";
  if (part.state !== "output-available") return "";
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as Record<string, unknown>
    : {};
  return formatAgentStructuredOutput(input.output);
}

function effectiveStepPhase(step: SpecRunStep, allSteps: SpecRunStep[]): DataAgentPartData["phase"] {
  const natural = stepPhase(step);
  if (natural === "finished" || natural === "failed") return natural;
  const laterProgress = allSteps.some((entry) =>
    entry.step_index > step.step_index
    && (entry.status === "succeeded"
      || entry.status === "waiting_for_interaction"
      || entry.status === "running"));
  if (laterProgress && step.status === "queued") return "finished";
  return natural;
}

function isDisplayableAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (/"emailDrafts"\s*:/.test(trimmed)) return false;
  return true;
}

export function resolveStreamTextForStep(step: SpecRunStep, messages: UIMessage[]): string {
  for (const message of messages) {
    if (message.role !== "assistant") continue;

    let headerIndex = -1;
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (!isDataAgentPart(part)) continue;
      const matchesIndex = typeof part.data.stepIndex === "number"
        && part.data.stepIndex === step.step_index;
      const matchesAgent = typeof part.data.agentId === "string"
        && part.data.agentId === step.agent_id;
      if (matchesIndex || matchesAgent) {
        headerIndex = index;
        break;
      }
    }
    if (headerIndex < 0) continue;

    for (let index = headerIndex + 1; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (isDataAgentPart(part)) break;
      if (part.type === "text" && isDisplayableAssistantText(part.text)) {
        return part.text.trim();
      }
      const finalized = readFinalizeAgentOutput(part);
      if (finalized) return finalized;
    }
  }

  return "";
}

export function resolveFinalizeAgentFromMessages(
  step: SpecRunStep,
  messages: UIMessage[],
): string {
  for (const message of messages) {
    if (message.role !== "assistant") continue;

    let headerIndex = -1;
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (!isDataAgentPart(part)) continue;
      const matchesIndex = typeof part.data.stepIndex === "number"
        && part.data.stepIndex === step.step_index;
      const matchesAgent = typeof part.data.agentId === "string"
        && part.data.agentId === step.agent_id;
      if (matchesIndex || matchesAgent) {
        headerIndex = index;
        break;
      }
    }
    if (headerIndex < 0) continue;

    for (let index = headerIndex + 1; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (isDataAgentPart(part)) break;
      const finalized = readFinalizeAgentOutput(part);
      if (finalized) return finalized;
    }
  }

  return "";
}

function fallbackStepDisplayText(step: SpecRunStep, allSteps: SpecRunStep[]): string {
  const effectivelyDone = step.status === "succeeded"
    || allSteps.some((entry) => entry.step_index > step.step_index
      && (entry.status === "succeeded" || entry.status === "waiting_for_interaction"));
  if (!effectivelyDone) return "";
  if (step.agent_snapshot.persona?.roleKey === "researcher") {
    return "Completed research and classification for this ticket.";
  }
  return "Step completed.";
}

function buildStepAssistantMessage(
  step: SpecRunStep,
  totalAgents: number,
  interactions: SpecRunInteraction[],
  allSteps: SpecRunStep[],
  messages: UIMessage[],
): UIMessage | null {
  const text = resolveStepDisplayText(step, interactions, {
    steps: allSteps,
    messages,
    resolveFinalizeAgent: resolveFinalizeAgentFromMessages,
  })
    || resolveStreamTextForStep(step, messages)
    || fallbackStepDisplayText(step, allSteps);
  const phase = effectiveStepPhase(step, allSteps);
  const persona = readPersona(step.agent_snapshot);
  const hasAgentHeader = Boolean(persona || step.agent_snapshot.name);
  if (!hasAgentHeader && !text && phase !== "working") return null;

  const parts: UIMessage["parts"] = [];
  if (hasAgentHeader) {
    parts.push({
      type: "data-agent",
      data: {
        agentId: step.agent_id,
        agentName: step.agent_snapshot.name,
        stepIndex: step.step_index,
        totalAgents,
        task: step.agent_snapshot.task,
        phase,
        ...(persona ? { persona } : {}),
      },
    } as UIMessage["parts"][number]);
  }
  if (text) {
    parts.push({ type: "text", text });
  }
  if (parts.length === 0) return null;

  return {
    id: `agent-turn-${step.id}`,
    role: "assistant",
    parts,
  };
}

export function buildAgentTurnMessagesFromSteps(
  steps: SpecRunStep[],
  interactions: SpecRunInteraction[],
  messages: UIMessage[],
): UIMessage[] {
  return buildSequentialStepTranscript({ steps, messages, interactions })
    .map((block) => block.message);
}

/** A single agent step rendered as one chronological block (header + tools + text). */
export type StepTranscriptBlock = {
  step: SpecRunStep;
  message: UIMessage;
  isLive: boolean;
  showArtifact: boolean;
};

function resolveActiveStepIndex(steps: SpecRunStep[]): number | null {
  const active = steps.find((entry) =>
    entry.status === "running" || entry.status === "waiting_for_interaction");
  return active?.step_index ?? null;
}

function buildHeaderPart(
  step: SpecRunStep,
  totalAgents: number,
  phase: DataAgentPartData["phase"],
): UIMessage["parts"][number] {
  const persona = readPersona(step.agent_snapshot);
  return {
    type: "data-agent",
    data: {
      agentId: step.agent_id,
      agentName: step.agent_snapshot.name,
      stepIndex: step.step_index,
      totalAgents,
      task: step.agent_snapshot.task,
      phase,
      ...(persona ? { persona } : {}),
    },
  } as UIMessage["parts"][number];
}

/** Parts other than the agent header are the "body" (tools, text, reasoning). */
function stripHeaderParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  return parts.filter((part) => !isDataAgentPart(part));
}

function isFinalizeAgentPart(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part) && getToolName(part) === FINALIZE_TOOL_NAME;
}

function isControlToolPart(part: UIMessage["parts"][number]): boolean {
  return isToolUIPart(part)
    && (getToolName(part) === FINALIZE_TOOL_NAME || GATE_TOOL_NAMES.has(getToolName(part)));
}

function toolParts(parts: UIMessage["parts"], options: { includeFinalize?: boolean } = {}): UIMessage["parts"] {
  return parts.filter((part) =>
    isToolUIPart(part)
    && (options.includeFinalize || !isFinalizeAgentPart(part)));
}

function terminalStepStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Does the body have anything worth showing (a tool call or non-empty text)? */
function bodyHasContent(parts: UIMessage["parts"]): boolean {
  return parts.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0;
    return true;
  });
}

function bodyHasText(parts: UIMessage["parts"]): boolean {
  return parts.some((part) => part.type === "text" && part.text.trim().length > 0);
}

function appendMissingVisibleText(
  body: UIMessage["parts"],
  fallbackParts: UIMessage["parts"],
): UIMessage["parts"] {
  if (bodyHasText(body)) return body;
  const fallbackText = fallbackParts.filter((part) => part.type === "text" && part.text.trim());
  return fallbackText.length > 0 ? [...body, ...fallbackText] : body;
}

function hydratedBodyForStep(input: {
  step: SpecRunStep;
  totalAgents: number;
  interactions: SpecRunInteraction[];
  steps: SpecRunStep[];
  messages: UIMessage[];
}): UIMessage["parts"] {
  const hydrated = buildStepAssistantMessage(
    input.step,
    input.totalAgents,
    input.interactions,
    input.steps,
    input.messages,
  );
  return hydrated ? stripHeaderParts(hydrated.parts) : [];
}

function interactionDecisionParts(
  step: SpecRunStep,
  interactions: SpecRunInteraction[],
): UIMessage["parts"] {
  return interactions
    .filter((interaction) => interaction.step_attempt_id === step.id)
    .map(formatInteractionDecision)
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ type: "text", text }));
}

/** Group streamed assistant message parts by step index (latest message wins per step). */
export function extractStreamPartsByStepIndex(messages: UIMessage[]): Map<number, UIMessage["parts"]> {
  const byStep = new Map<number, UIMessage["parts"]>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    let currentStepIndex: number | null = null;
    let currentParts: UIMessage["parts"] = [];

    const flush = () => {
      if (currentStepIndex !== null && currentParts.length > 0) {
        byStep.set(currentStepIndex, currentParts);
      }
      currentParts = [];
    };

    for (const part of message.parts) {
      if (isDataAgentPart(part) && typeof part.data.stepIndex === "number") {
        flush();
        currentStepIndex = part.data.stepIndex;
        currentParts = [part];
      } else if (currentStepIndex !== null) {
        currentParts.push(part);
      }
    }
    flush();
  }

  return byStep;
}

/**
 * Build a linear step-by-step transcript: one block per started agent, in step_index
 * order, with streamed tools/text merged inline under each agent header.
 */
export function buildSequentialStepTranscript(input: {
  steps: SpecRunStep[];
  messages: UIMessage[];
  interactions: SpecRunInteraction[];
  chatStatus?: string;
  pendingInteractionStepAttemptId?: string | null;
}): StepTranscriptBlock[] {
  const latestSteps = latestAttemptPerStep(input.steps);
  if (latestSteps.length === 0) return [];

  const visibleMessages = input.messages.filter((message) => !isHiddenControlMessage(message));
  const streamPartsByStep = extractStreamPartsByStepIndex(visibleMessages);
  const activeStepIndex = resolveActiveStepIndex(latestSteps);
  const isStreaming = input.chatStatus === "streaming" || input.chatStatus === "submitted";
  const totalAgents = latestSteps.length;
  const blocks: StepTranscriptBlock[] = [];

  for (const step of latestSteps) {
    const streamParts = streamPartsByStep.get(step.step_index);
    const hasStreamParts = Boolean(streamParts && streamParts.length > 0);

    // Reveal a step if it has started, OR if the live stream is already emitting for it
    // (run.steps polling is paused during streaming so it can lag behind the stream).
    if (step.status === "queued" && !hasStreamParts) continue;

    // Phase: persisted status wins, but a step with active stream output is "working".
    let phase = effectiveStepPhase(step, latestSteps);
    if (hasStreamParts
      && step.status !== "succeeded"
      && step.status !== "failed"
      && step.status !== "cancelled") {
      phase = "working";
    }

    // Header is ALWAYS rebuilt from the authoritative step row so the agent card is
    // stable and never flickers between the stream and the polled-step sources.
    const header = buildHeaderPart(step, totalAgents, phase);

    // Anchor the artifact to the step the pending interaction belongs to. Use the
    // interaction (not the polled step status) as the source of truth so the editor
    // shows in sync with the gate composer even while run.steps lags behind.
    const showArtifact = Boolean(input.pendingInteractionStepAttemptId)
      && step.id === input.pendingInteractionStepAttemptId;
    const isLive = isStreaming
      && hasStreamParts
      && !terminalStepStatus(step.status)
      && (activeStepIndex === null || step.step_index === activeStepIndex);

    const streamBody = hasStreamParts ? stripHeaderParts(streamParts!) : [];
    const streamedTools = toolParts(streamBody);
    const hasFinalizeOutput = streamBody.some((part) => Boolean(readFinalizeAgentOutput(part)));
    const hydratedBody = hydratedBodyForStep({
      step,
      totalAgents,
      interactions: input.interactions,
      steps: latestSteps,
      messages: visibleMessages,
    });
    const decisionBody = interactionDecisionParts(step, input.interactions);

    let body: UIMessage["parts"] = [];
    if (showArtifact) {
      body = [...streamedTools, ...decisionBody];
    } else if (isLive) {
      // Once a finalize/gate tool appears, preceding prose is just scratchpad
      // narration. Keep the run fast and live, but stop showing that prose.
      body = streamBody.some(isControlToolPart)
        ? toolParts(streamBody, { includeFinalize: true })
        : streamBody;
      if (!bodyHasContent(body) && bodyHasContent(hydratedBody)) body = hydratedBody;
      body = [...body, ...decisionBody];
    } else if (hasFinalizeOutput) {
      body = [
        ...streamedTools,
        ...streamBody.filter(isFinalizeAgentPart),
        ...decisionBody,
      ];
    } else {
      body = [
        ...streamedTools,
        ...hydratedBody,
        ...decisionBody,
      ];
    }
    body = appendMissingVisibleText(body, [...decisionBody, ...hydratedBody]);

    blocks.push({
      step,
      isLive,
      showArtifact,
      message: {
        id: `step-transcript-${step.id}`,
        role: "assistant",
        parts: [header, ...body],
      },
    });
  }

  return blocks;
}

export function hydrateMessagesFromSteps(
  messages: UIMessage[],
  steps: SpecRunStep[],
  interactions: SpecRunInteraction[] = [],
): UIMessage[] {
  return messages.filter((message) => !isHiddenControlMessage(message));
}

export function isGateCompletionMessage(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if (!isToolUIPart(part)) return false;
    // Include both successful (output-available) and failed (input-available with error text)
    // completions so validation errors don't silently vanish from the transcript.
    const state = part.state;
    if (state !== "output-available" && state !== "input-available") return false;
    return GATE_TOOL_NAMES.has(getToolName(part));
  });
}

export function shouldAutoStartRunStream(input: {
  runStatus: string;
  messages: UIMessage[];
  pendingInteraction: boolean;
  chatStatus: string;
}): boolean {
  if (input.pendingInteraction) return false;
  if (input.chatStatus === "streaming" || input.chatStatus === "submitted") return false;
  if (input.runStatus !== "queued" && input.runStatus !== "running") return false;
  return !hasSubstantiveAssistantMessages(input.messages);
}
