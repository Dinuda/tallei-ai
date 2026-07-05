import type { UIMessage } from "ai";

import {
  derivePendingUiToolFromEvents,
  getConductorExecutionMetadata,
  isTerminalConductorExecution,
  projectChatMessages,
  type ConductorPhaseTurnPayload,
  type LoopBuildEvent,
  type PendingUiToolCall,
} from "./build-events.js";
import { deriveBuildPhaseProgress, type BuildPhaseProgress } from "./build-phase-progress.js";
import type { ConductorExecutionMetadata } from "./conductor-tools.js";
import {
  loopBuildStateSchema,
  projectLoopSpec,
  type LoopBuildState,
} from "./build-state.js";
import type { LoopSpec } from "./spec.js";

export type LoopBuildProjectionContext = {
  connectedToolkits?: Array<{ slug: string; connected: boolean }>;
  resumeTool?: string | null;
  effectivePhase?: LoopBuildState["buildPhase"];
  loopStatus?: string;
};

export type LoopBuildProjection = {
  state: LoopBuildState | null;
  spec: LoopSpec | null;
  chatMessages: UIMessage[];
  phaseProgress: BuildPhaseProgress | null;
  latestPhaseTurn: ConductorPhaseTurnPayload | null;
  pendingUiTool: PendingUiToolCall | null;
  latestTerminalExecution: ConductorExecutionMetadata | null;
  consumedHandoffIds: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Latest embedded LoopBuildState from artifact or recovery events. */
export function projectBuildStateFromEvents(events: LoopBuildEvent[]): LoopBuildState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "artifact.committed" && event.type !== "phase.recovery_requested") continue;
    const state = event.payload.state;
    if (!state) continue;
    const parsed = loopBuildStateSchema.safeParse(state);
    if (!parsed.success) continue;
    validateArtifactEnvelopeConsistency(event, parsed.data);
    return parsed.data;
  }
  return null;
}

function validateArtifactEnvelopeConsistency(event: LoopBuildEvent, state: LoopBuildState): void {
  if (event.type !== "artifact.committed") return;
  const envelope = event.payload.envelope;
  if (!isRecord(envelope)) return;
  const phase = String(envelope.phase ?? "");
  if (!phase || !state.artifacts[phase as keyof typeof state.artifacts]) return;
  const embedded = state.artifacts[phase as keyof typeof state.artifacts];
  const envelopeId = String(envelope.id ?? "");
  if (embedded && envelopeId && embedded.id !== envelopeId) {
    console.warn(`[build-projection] artifact envelope id mismatch for ${phase}`, {
      envelopeId,
      stateId: embedded.id,
      eventKey: event.eventKey,
    });
  }
}

export function projectLatestPhaseTurn(events: LoopBuildEvent[]): ConductorPhaseTurnPayload | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "phase_turn.completed") continue;
    const payload = event.payload;
    if (!isRecord(payload)) continue;
    const phase = String(payload.phase ?? "");
    const parentArtifactHash = String(payload.parentArtifactHash ?? "");
    const outcome = String(payload.outcome ?? "");
    const continuation = String(payload.continuation ?? "");
    if (!phase || !parentArtifactHash || !outcome || !continuation) continue;
    return {
      phase,
      parentArtifactHash,
      stepsUsed: Number(payload.stepsUsed ?? 0),
      stepLimit: Number(payload.stepLimit ?? 0),
      outcome,
      continuation,
      ...(typeof payload.nextPhase === "string" ? { nextPhase: payload.nextPhase } : {}),
      ...(typeof payload.handoffId === "string" ? { handoffId: payload.handoffId } : {}),
      ...(typeof payload.compiledPlanId === "string" ? { compiledPlanId: payload.compiledPlanId } : {}),
      ...(typeof payload.recoveryPhase === "string" ? { recoveryPhase: payload.recoveryPhase } : {}),
      ...(typeof payload.recoveryReason === "string" ? { recoveryReason: payload.recoveryReason } : {}),
      ...(typeof payload.noProgressFingerprint === "string" ? { noProgressFingerprint: payload.noProgressFingerprint } : {}),
      ...(typeof payload.resolutionReason === "string" ? { resolutionReason: payload.resolutionReason } : {}),
      ...(typeof payload.pendingToolCallId === "string" ? { pendingToolCallId: payload.pendingToolCallId } : {}),
      ...(typeof payload.resumeAfterAnswer === "boolean" ? { resumeAfterAnswer: payload.resumeAfterAnswer } : {}),
    };
  }
  return null;
}

export function projectConsumedHandoffIds(events: LoopBuildEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "phase_handoff.consumed") return [];
    const handoffId = event.payload.handoffId;
    return typeof handoffId === "string" && handoffId.trim().length > 0 ? [handoffId] : [];
  });
}

export function projectLatestTerminalExecution(events: LoopBuildEvent[]): ConductorExecutionMetadata | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const metadata = getConductorExecutionMetadata(events[index]!);
    if (!metadata || !isTerminalConductorExecution(metadata)) continue;
    return metadata;
  }
  return null;
}

/** Single read model for Conductor build orchestration from the event log. */
export function projectLoopBuild(
  events: LoopBuildEvent[],
  context: LoopBuildProjectionContext = {},
): LoopBuildProjection {
  const state = projectBuildStateFromEvents(events);
  const chatMessages = projectChatMessages(events);
  const pendingUiTool = derivePendingUiToolFromEvents(events);
  const phaseProgress = state
    ? deriveBuildPhaseProgress(state, events, {
      effectivePhase: context.effectivePhase,
      resumeTool: context.resumeTool ?? null,
      connectedToolkits: context.connectedToolkits,
      loopStatus: context.loopStatus,
    })
    : null;
  return {
    state,
    spec: state ? projectLoopSpec(state) : null,
    chatMessages,
    phaseProgress,
    latestPhaseTurn: projectLatestPhaseTurn(events),
    pendingUiTool,
    latestTerminalExecution: projectLatestTerminalExecution(events),
    consumedHandoffIds: projectConsumedHandoffIds(events),
  };
}
