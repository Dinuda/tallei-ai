import type { UIMessage } from "ai";

import type { AuthContext } from "../domain/auth/index.js";
import type { BuildPhase, LoopBuildState } from "./build-state.js";
import {
  appendConductorStallRecoveryMessage,
  type ConductorStallRecoveryContext,
} from "./conductor-chat.js";
import { recoverMissingPickConnectorApp } from "./conductor-pick-recovery.js";
import { logConductorTurnStall } from "./conductor-stream-diagnostics.js";
import type { LoopBuildProjection } from "./build-state-projection.js";
import {
  isTerminalConductorExecution,
  makeConductorPhaseTurnEvent,
  type ConductorPhaseTurnPayload,
} from "./build-events.js";
import { resolveConductorTurnResolution } from "./conductor-turn-resolution.js";
import type { ConductorExecutionMetadata, PhaseExecutionContract } from "./conductor-tools.js";

export type FinalizeConductorTurnInput = {
  auth: AuthContext;
  loopId: string;
  messages: UIMessage[];
  isAborted: boolean;
  streamElapsedMs: number;
  stepTimingsMs: number[];
  requestPhaseContract: PhaseExecutionContract;
  requestStartPhase: BuildPhase;
  requestStartParentArtifactHash: string;
  requestStepLimit: number;
  turnStepCount: number;
  turnStreamError: string | null;
  lastToolExecution: ConductorExecutionMetadata | null;
  modelId: string;
  currentBuildState: LoopBuildState;
  currentLoopStatus: string;
  refreshBuildProjection: (context?: { effectivePhase?: BuildPhase }) => Promise<LoopBuildProjection>;
  appendBuildEvents: (
    auth: AuthContext,
    loopId: string,
    events: Parameters<typeof import("./store.js").appendBuildEvents>[2],
  ) => Promise<unknown>;
  saveBuildChatMessages: (
    auth: AuthContext,
    loopId: string,
    messages: UIMessage[],
  ) => Promise<UIMessage[]>;
};

export async function finalizeConductorTurnBookkeeping(
  input: FinalizeConductorTurnInput,
): Promise<{ projectionMs: number; phaseTurnMs: number; stallRecoveryMs: number }> {
  const timings = { projectionMs: 0, phaseTurnMs: 0, stallRecoveryMs: 0 };
  const projectionStarted = performance.now();
  let refreshed = await input.refreshBuildProjection({ effectivePhase: input.requestPhaseContract.phase });
  timings.projectionMs = performance.now() - projectionStarted;

  let workingMessages = input.messages;
  const pickRecovery = recoverMissingPickConnectorApp({
    messages: workingMessages,
    state: refreshed.state ?? input.currentBuildState,
    pendingUiTool: refreshed.pendingUiTool,
    nextTool: refreshed.phaseProgress?.nextTool ?? input.requestPhaseContract.nextTool,
    phase: input.requestStartPhase,
  });
  if (pickRecovery.injected) {
    workingMessages = pickRecovery.messages;
    await input.saveBuildChatMessages(input.auth, input.loopId, workingMessages);
    console.warn(`[loops/chat:${input.loopId}] injected missing pickConnectorApp after reasoning-only turn`, {
      loopId: input.loopId,
      toolCallId: pickRecovery.toolCallId,
      outcomeId: pickRecovery.outcomeId,
      modelId: input.modelId,
    });
    refreshed = await input.refreshBuildProjection({ effectivePhase: input.requestPhaseContract.phase });
  }

  const terminalExecution = !refreshed.pendingUiTool
    && input.lastToolExecution
    && input.lastToolExecution.phaseBefore === input.requestStartPhase
    && input.lastToolExecution.parentArtifactHash === input.requestStartParentArtifactHash
    && isTerminalConductorExecution(input.lastToolExecution)
    ? input.lastToolExecution
    : null;

  let phaseTurnPayload: ConductorPhaseTurnPayload | null = terminalExecution ? {
    phase: input.requestStartPhase,
    parentArtifactHash: input.requestStartParentArtifactHash,
    stepsUsed: terminalExecution.stepsUsed,
    stepLimit: input.requestStepLimit,
    outcome: terminalExecution.turnOutcome,
    continuation: terminalExecution.continuation,
    ...(terminalExecution.nextPhase ? { nextPhase: terminalExecution.nextPhase } : {}),
    ...(terminalExecution.handoffId ? { handoffId: terminalExecution.handoffId } : {}),
    ...(terminalExecution.compiledPlanId ? { compiledPlanId: terminalExecution.compiledPlanId } : {}),
    ...(terminalExecution.recoveryPhase ? { recoveryPhase: terminalExecution.recoveryPhase } : {}),
    ...(terminalExecution.recoveryReason ? { recoveryReason: terminalExecution.recoveryReason } : {}),
    ...(terminalExecution.noProgressFingerprint ? { noProgressFingerprint: terminalExecution.noProgressFingerprint } : {}),
  } : null;

  if (!phaseTurnPayload) {
    const phaseProgress = refreshed.phaseProgress;
    if (phaseProgress) {
      const resolution = resolveConductorTurnResolution({
        contract: input.requestPhaseContract,
        currentState: refreshed.state ?? input.currentBuildState,
        phaseProgress,
        latestPhaseTurn: refreshed.latestPhaseTurn,
        pendingUiTool: refreshed.pendingUiTool,
        loopStatus: input.currentLoopStatus,
        stepsUsed: input.turnStepCount,
        stepLimit: input.requestStepLimit,
      });
      if (resolution) {
        phaseTurnPayload = {
          phase: input.requestStartPhase,
          parentArtifactHash: input.requestStartParentArtifactHash,
          stepsUsed: input.turnStepCount,
          stepLimit: input.requestStepLimit,
          outcome: resolution.outcome,
          continuation: resolution.continuation,
          ...("nextPhase" in resolution && resolution.nextPhase ? { nextPhase: resolution.nextPhase } : {}),
          ...("handoffId" in resolution && resolution.handoffId ? { handoffId: resolution.handoffId } : {}),
          ...("recoveryPhase" in resolution && resolution.recoveryPhase ? { recoveryPhase: resolution.recoveryPhase } : {}),
          ...("recoveryReason" in resolution && resolution.recoveryReason ? { recoveryReason: resolution.recoveryReason } : {}),
          ...(resolution.noProgressFingerprint ? { noProgressFingerprint: resolution.noProgressFingerprint } : {}),
          ...("pendingToolCallId" in resolution && resolution.pendingToolCallId ? { pendingToolCallId: resolution.pendingToolCallId } : {}),
          ...("resumeAfterAnswer" in resolution && resolution.resumeAfterAnswer !== undefined ? { resumeAfterAnswer: resolution.resumeAfterAnswer } : {}),
          resolutionReason: resolution.reason,
        };
      }
    }
  }

  const phaseTurnStarted = performance.now();
  if (phaseTurnPayload) {
    await input.appendBuildEvents(input.auth, input.loopId, [makeConductorPhaseTurnEvent(phaseTurnPayload)]);
  }
  timings.phaseTurnMs = performance.now() - phaseTurnStarted;

  const shouldLogStall = Boolean(input.turnStreamError)
    || input.turnStepCount === 0
    || phaseTurnPayload?.outcome === "blocked";

  if (shouldLogStall && !pickRecovery.injected) {
    const stallContext: ConductorStallRecoveryContext = {
      streamError: input.turnStreamError,
      stepsUsed: input.turnStepCount,
      outcome: phaseTurnPayload?.outcome,
      resolutionReason: phaseTurnPayload?.resolutionReason,
      pendingUiTool: refreshed.pendingUiTool,
    };
    logConductorTurnStall({
      loopId: input.loopId,
      phase: input.requestStartPhase,
      nextTool: input.requestPhaseContract.nextTool,
      modelId: input.modelId,
      stepsUsed: input.turnStepCount,
      streamError: input.turnStreamError,
      outcome: phaseTurnPayload?.outcome,
      resolutionReason: phaseTurnPayload?.resolutionReason,
      messages: workingMessages,
      streamElapsedMs: input.streamElapsedMs,
      stepTimingsMs: input.stepTimingsMs,
      pendingUiTool: refreshed.pendingUiTool,
    });

    const stallRecoveryStarted = performance.now();
    const recoveredMessages = appendConductorStallRecoveryMessage(workingMessages, stallContext);
    if (recoveredMessages !== workingMessages) {
      await input.saveBuildChatMessages(input.auth, input.loopId, recoveredMessages);
    }
    timings.stallRecoveryMs = performance.now() - stallRecoveryStarted;
  }

  return timings;
}
