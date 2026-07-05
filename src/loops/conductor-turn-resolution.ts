import {
  eventPayloadHash,
  type ConductorPhaseTurnPayload,
  type PendingUiToolCall,
} from "./build-events.js";
import type { BuildPhaseProgress } from "./build-phase-progress.js";
import type { PhaseExecutionContract } from "./conductor-tools.js";
import type { LoopBuildState } from "./build-state.js";

export type ConductorTurnResolution =
  | {
    outcome: "waiting_for_user" | "budget_exhausted" | "blocked" | "build_complete";
    continuation: "wait_for_user" | "stop";
    reason: string;
    pendingToolCallId?: string;
    resumeAfterAnswer?: boolean;
  }
  | {
    outcome: "phase_complete" | "progress";
    continuation: "next_phase" | "continue_phase";
    reason: string;
    nextPhase: LoopBuildState["buildPhase"];
    handoffId: string;
    noProgressFingerprint?: string;
    recoveryPhase?: LoopBuildState["buildPhase"];
    recoveryReason?: string;
  };

function isSameRevision(
  state: LoopBuildState,
  contract: PhaseExecutionContract,
): boolean {
  if (state.buildPhase !== contract.phase) return false;
  const phaseIndex = ["intent", "blueprint", "connectors", "bindings", "review", "compile", "test", "activation"]
    .indexOf(contract.phase);
  const parentHash = phaseIndex > 0
    ? state.artifacts[["intent", "blueprint", "connectors", "bindings", "review", "compile", "test", "activation"][phaseIndex - 1] as keyof typeof state.artifacts]?.artifactHash ?? "root"
    : "root";
  return parentHash === contract.parentArtifactHash;
}

export function buildNoProgressFingerprint(input: {
  contract: PhaseExecutionContract;
  phaseProgress: BuildPhaseProgress;
}): string {
  return eventPayloadHash({
    revision: input.contract.revision,
    nextTool: input.phaseProgress.nextTool,
    allowedTools: input.phaseProgress.allowedTools,
    reason: input.phaseProgress.reason ?? null,
    status: input.phaseProgress.status,
  });
}

export function resolveConductorTurnResolution(input: {
  contract: PhaseExecutionContract;
  currentState: LoopBuildState;
  phaseProgress: BuildPhaseProgress;
  latestPhaseTurn: ConductorPhaseTurnPayload | null;
  pendingUiTool: PendingUiToolCall | null;
  loopStatus: string;
  stepsUsed: number;
  stepLimit: number;
}): ConductorTurnResolution | null {
  if (!isSameRevision(input.currentState, input.contract)) {
    const nextPhase = input.currentState.buildPhase;
    const handoffId = eventPayloadHash({
      kind: "superseded",
      from: input.contract.revision,
      to: `${nextPhase}`,
    });
    return {
      outcome: nextPhase === "activation" && input.loopStatus === "active" ? "build_complete" : "phase_complete",
      continuation: nextPhase === "activation" && input.loopStatus === "active" ? "stop" : "next_phase",
      nextPhase,
      handoffId,
      reason: "phase_contract_superseded",
    } as ConductorTurnResolution;
  }

  if (input.pendingUiTool) {
    return {
      outcome: "waiting_for_user",
      continuation: "wait_for_user",
      reason: "pending_user_input",
      pendingToolCallId: input.pendingUiTool.toolCallId,
      resumeAfterAnswer: true,
    };
  }

  if (input.phaseProgress.terminal) {
    if (input.contract.phase === "activation" && input.loopStatus === "active") {
      return {
        outcome: "build_complete",
        continuation: "stop",
        reason: input.phaseProgress.reason ?? "activation_complete",
      };
    }
    const handoffId = eventPayloadHash({
      kind: "phase_complete",
      revision: input.contract.revision,
      nextPhase: input.currentState.buildPhase,
    });
    return {
      outcome: "phase_complete",
      continuation: "next_phase",
      nextPhase: input.currentState.buildPhase,
      handoffId,
      reason: input.phaseProgress.reason ?? "phase_complete",
    };
  }

  if (input.stepsUsed >= input.stepLimit) {
    return {
      outcome: "budget_exhausted",
      continuation: "stop",
      reason: "phase_budget_exhausted",
    };
  }

  const actionable = input.phaseProgress.nextTool
    && input.phaseProgress.allowedTools.includes(input.phaseProgress.nextTool);
  if (!actionable) {
    return {
      outcome: "blocked",
      continuation: "stop",
      reason: input.phaseProgress.reason ?? "no_actionable_next_tool",
    };
  }

  const noProgressFingerprint = buildNoProgressFingerprint({
    contract: input.contract,
    phaseProgress: input.phaseProgress,
  });
  if (input.latestPhaseTurn?.phase === input.contract.phase
    && input.latestPhaseTurn.parentArtifactHash === input.contract.parentArtifactHash
    && input.latestPhaseTurn.noProgressFingerprint === noProgressFingerprint
    && input.latestPhaseTurn.continuation === "continue_phase") {
    return {
      outcome: "blocked",
      continuation: "stop",
      reason: "repeated_no_progress",
    };
  }

  const handoffId = eventPayloadHash({
    kind: "continue_phase",
    revision: input.contract.revision,
    fingerprint: noProgressFingerprint,
  });
  return {
    outcome: "progress",
    continuation: "continue_phase",
    nextPhase: input.contract.phase,
    handoffId,
    noProgressFingerprint,
    reason: input.phaseProgress.reason ?? "phase_work_remaining",
  };
}
