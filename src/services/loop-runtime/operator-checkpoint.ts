import type { InputRequirement, InputSurface } from "../loop-engine/input-surfaces.js";
import { defaultLabelForKey, defaultSurfaceForGateType } from "../loop-engine/input-surfaces.js";

export type OperatorCheckpointReason =
  | "missing_requirements"
  | "review"
  | "confirm_external_effect";

export type OperatorCheckpointSurface = {
  key: string;
  surface: InputSurface;
  required: boolean;
  satisfied: boolean;
  label?: string;
  description?: string;
  props?: Record<string, unknown>;
};

export type OperatorCheckpoint = {
  reason: OperatorCheckpointReason;
  surfaces: OperatorCheckpointSurface[];
  blocking: {
    agentId?: string;
    stepIndex?: number;
  };
};

export type OperatorCheckpointKind = "requirement" | "approval" | "unknown";
export type OperatorCheckpointContinuation = "retry_step" | "complete_step";

export function readOperatorCheckpoint(payload: Record<string, unknown> | null | undefined): OperatorCheckpoint | null {
  if (!payload || typeof payload !== "object") return null;
  const checkpoint = payload.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const row = checkpoint as Record<string, unknown>;
  const surfaces = Array.isArray(row.surfaces)
    ? row.surfaces.filter((item): item is OperatorCheckpointSurface =>
        Boolean(item)
        && typeof item === "object"
        && typeof (item as OperatorCheckpointSurface).key === "string"
        && typeof (item as OperatorCheckpointSurface).surface === "string",
      )
    : [];
  if (surfaces.length === 0) return null;
  const reason = row.reason;
  const parsedReason: OperatorCheckpointReason = reason === "review"
    || reason === "confirm_external_effect"
    ? reason
    : "missing_requirements";
  const blocking = row.blocking && typeof row.blocking === "object" && !Array.isArray(row.blocking)
    ? row.blocking as OperatorCheckpoint["blocking"]
    : {};
  return { reason: parsedReason, surfaces, blocking };
}

export function classifyOperatorCheckpoint(
  payload: Record<string, unknown> | null | undefined,
): OperatorCheckpointKind {
  const checkpoint = readOperatorCheckpoint(payload);
  if (!checkpoint) return "unknown";
  return checkpoint.reason === "missing_requirements" ? "requirement" : "approval";
}

export function resolveOperatorCheckpointContinuation(input: {
  payload: Record<string, unknown> | null | undefined;
  legacyRequirementGate: boolean;
  runStartInputCollector: boolean;
}): OperatorCheckpointContinuation {
  const kind = classifyOperatorCheckpoint(input.payload);
  const requirementGate = kind === "requirement"
    || (kind === "unknown" && input.legacyRequirementGate);
  if (!requirementGate) return "complete_step";
  const when = input.payload?.when === "before_send" || input.payload?.when === "before_step"
    ? input.payload.when
    : "run_start";
  return when === "run_start" && input.runStartInputCollector
    ? "complete_step"
    : "retry_step";
}

export function buildRequirementCheckpoint(input: {
  requirements: InputRequirement[];
  blocking?: OperatorCheckpoint["blocking"];
  propsForKey?: (key: string) => Record<string, unknown> | undefined;
  satisfiedKeys?: Set<string>;
}): OperatorCheckpoint {
  const satisfiedKeys = input.satisfiedKeys ?? new Set<string>();
  return {
    reason: "missing_requirements",
    blocking: input.blocking ?? {},
    surfaces: input.requirements.map((req) => ({
      key: req.key,
      surface: req.surface,
      required: req.required,
      satisfied: satisfiedKeys.has(req.key),
      label: req.label ?? defaultLabelForKey(req.key),
      description: req.description,
      ...(input.propsForKey?.(req.key) ? { props: input.propsForKey(req.key) } : {}),
    })),
  };
}

export function buildApprovalCheckpoint(input: {
  gateType: string;
  surface?: InputSurface;
  key?: string;
  blocking?: OperatorCheckpoint["blocking"];
  props?: Record<string, unknown>;
}): OperatorCheckpoint {
  const surface = input.surface ?? defaultSurfaceForGateType(input.gateType);
  const reason: OperatorCheckpointReason = input.gateType === "pre_send"
    ? "confirm_external_effect"
    : "review";
  const key = input.key ?? (surface === "review.sources"
    ? "approved_sources"
    : surface === "review.memories"
      ? "approved_memories"
      : surface === "confirm.send"
        ? "confirm_send"
        : "review");
  return {
    reason,
    blocking: input.blocking ?? {},
    surfaces: [{
      key,
      surface,
      required: true,
      satisfied: false,
      ...(input.props ? { props: input.props } : {}),
    }],
  };
}

export function checkpointPayload(input: {
  checkpoint: OperatorCheckpoint;
  agentId?: string;
  stepIndex?: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    checkpoint: input.checkpoint,
    agentId: input.agentId ?? input.checkpoint.blocking.agentId,
    stepIndex: input.stepIndex ?? input.checkpoint.blocking.stepIndex,
    surfaces: input.checkpoint.surfaces,
    ...(input.extra ?? {}),
  };
}

export function checkpointQuestion(checkpoint: OperatorCheckpoint): string {
  const pending = checkpoint.surfaces.filter((surface) => surface.required && !surface.satisfied);
  if (pending.length === 1) {
    const surface = pending[0]!;
    return surface.description ?? `Provide ${surface.label ?? surface.key} to continue.`;
  }
  if (pending.length > 1) {
    return `Provide ${pending.map((surface) => surface.label ?? surface.key).join(", ")} to continue.`;
  }
  return "Review and continue.";
}
