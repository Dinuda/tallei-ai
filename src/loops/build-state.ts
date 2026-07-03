import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  agentConfigSchema,
  approvalPolicySchema,
  composioActionInstructionSchema,
  executionProfileSchema,
  guardrailConfigSchema,
  intentSchema,
  monitorConfigSchema,
  outputConfigSchema,
  syncConfigSchema,
  taskBlueprintSchema,
  toolBindingSchema,
  triggerSchema,
  type LoopSpec,
} from "./spec.js";
import { intentAnalysisSchema } from "./intent-discovery.js";
import { computeOutcomeBriefHash } from "./outcome-brief.js";

export const BUILD_PHASES = [
  "intent", "blueprint", "connectors", "bindings", "review", "compile", "test", "activation",
] as const;
export const buildPhaseSchema = z.enum(BUILD_PHASES);
export type BuildPhase = z.infer<typeof buildPhaseSchema>;

export const userFacingBuildStageSchema = z.enum([
  "understand", "design", "connect_tools", "review_and_activate",
]);
export type UserFacingBuildStage = z.infer<typeof userFacingBuildStageSchema>;

export function userFacingStageForPhase(phase: BuildPhase): UserFacingBuildStage {
  if (phase === "intent") return "understand";
  if (phase === "blueprint") return "design";
  if (phase === "connectors" || phase === "bindings") return "connect_tools";
  return "review_and_activate";
}

const sourceHintSchema = z.object({
  channel: z.string().min(1),
  userMentionedApp: z.string().min(1).optional(),
});

export const intentArtifactSchema = z.object({
  workspaceId: z.string().uuid(),
  intent: intentSchema,
  startCondition: z.string().min(1),
  sourceHints: z.array(sourceHintSchema).default([]),
  analysis: intentAnalysisSchema.optional(),
}).strict();

export const blueprintArtifactSchema = z.object({
  taskBlueprint: taskBlueprintSchema,
  profile: executionProfileSchema.default("agentic"),
  agent: agentConfigSchema.optional(),
  approval: approvalPolicySchema.default({}),
  guardrails: guardrailConfigSchema.default({}),
  monitor: monitorConfigSchema.optional(),
  sync: syncConfigSchema.optional(),
}).strict();

export const connectorSelectionSchema = z.object({
  outcomeId: z.string().min(1),
  connector: z.string().min(1),
  confirmedByUser: z.literal(true),
});
export const connectorArtifactSchema = z.object({
  selections: z.array(connectorSelectionSchema).min(1),
}).strict();

export const bindingArtifactSchema = z.object({
  trigger: triggerSchema,
  bindings: z.array(toolBindingSchema).min(1),
  composioActions: z.array(composioActionInstructionSchema).default([]),
  output: outputConfigSchema.default({ kind: "none" }),
}).strict();

export const reviewArtifactSchema = z.object({
  bindingHash: z.string().length(64),
  confirmedByUser: z.literal(true),
  confirmedAt: z.string().datetime(),
}).strict();
export const compileArtifactSchema = z.object({
  reviewHash: z.string().length(64),
  compiledPlanId: z.string().uuid(),
  compiledPlanHash: z.string().min(1),
}).strict();
export const testArtifactSchema = z.object({
  compileHash: z.string().length(64),
  compiledPlanId: z.string().uuid(),
  runId: z.string().uuid(),
  passed: z.literal(true),
}).strict();
export const activationArtifactSchema = z.object({
  testHash: z.string().length(64),
  compiledPlanId: z.string().uuid(),
  confirmedByUser: z.literal(true),
  activatedAt: z.string().datetime(),
}).strict();

export const artifactPayloadSchemas = {
  intent: intentArtifactSchema,
  blueprint: blueprintArtifactSchema,
  connectors: connectorArtifactSchema,
  bindings: bindingArtifactSchema,
  review: reviewArtifactSchema,
  compile: compileArtifactSchema,
  test: testArtifactSchema,
  activation: activationArtifactSchema,
} satisfies Record<BuildPhase, z.ZodTypeAny>;

export const artifactEnvelopeSchema = z.object({
  id: z.string().uuid(),
  phase: buildPhaseSchema,
  revision: z.number().int().positive(),
  parentRevision: z.number().int().positive().optional(),
  parentHash: z.string().length(64).optional(),
  artifactHash: z.string().length(64),
  artifact: z.unknown(),
  createdAt: z.string().datetime(),
}).superRefine((value, ctx) => {
  const parsed = artifactPayloadSchemas[value.phase].safeParse(value.artifact);
  if (!parsed.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error.message, path: ["artifact"] });
  }
  if (value.artifactHash !== hashArtifact(value.artifact)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifactHash does not match artifact payload", path: ["artifactHash"] });
  }
});
export type ArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;

export const buildInvalidationSchema = z.object({
  reason: z.string().min(1),
  invalidatedAt: z.string().datetime(),
  fromPhase: buildPhaseSchema,
  phases: z.array(buildPhaseSchema),
});

export const loopBuildStateSchema = z.object({
  buildPhase: buildPhaseSchema,
  artifacts: z.object({
    intent: artifactEnvelopeSchema.optional(),
    blueprint: artifactEnvelopeSchema.optional(),
    connectors: artifactEnvelopeSchema.optional(),
    bindings: artifactEnvelopeSchema.optional(),
    review: artifactEnvelopeSchema.optional(),
    compile: artifactEnvelopeSchema.optional(),
    test: artifactEnvelopeSchema.optional(),
    activation: artifactEnvelopeSchema.optional(),
  }).strict(),
  invalidations: z.array(buildInvalidationSchema).default([]),
}).strict().superRefine((value, ctx) => {
  for (const phase of BUILD_PHASES) {
    const envelope = value.artifacts[phase];
    if (!envelope) continue;
    if (envelope.phase !== phase) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Artifact key ${phase} contains ${envelope.phase}`, path: ["artifacts", phase] });
    }
    const index = BUILD_PHASES.indexOf(phase);
    if (index === 0) continue;
    const parent = value.artifacts[BUILD_PHASES[index - 1]];
    if (!parent || envelope.parentHash !== parent.artifactHash || envelope.parentRevision !== parent.revision) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${phase} parent reference is stale`, path: ["artifacts", phase] });
    }
  }
});
export type LoopBuildState = z.infer<typeof loopBuildStateSchema>;

export const BUILD_ERROR_CODES = {
  INVALID_TRANSITION: "BUILD_INVALID_TRANSITION",
  STALE_PARENT: "BUILD_STALE_PARENT",
  UNSELECTED_CONNECTOR: "BUILD_UNSELECTED_CONNECTOR",
  USER_CONFIRMATION_REQUIRED: "BUILD_USER_CONFIRMATION_REQUIRED",
  PLAN_MISMATCH: "BUILD_PLAN_MISMATCH",
  PASSING_TEST_REQUIRED: "BUILD_PASSING_TEST_REQUIRED",
} as const;

export class BuildStateError extends Error {
  constructor(public readonly code: typeof BUILD_ERROR_CODES[keyof typeof BUILD_ERROR_CODES], message: string) {
    super(message);
    this.name = "BuildStateError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

export function hashArtifact(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function createBuildState(): LoopBuildState {
  return { buildPhase: "intent", artifacts: {}, invalidations: [] };
}

export function commitBuildArtifact(input: {
  state: LoopBuildState;
  phase: BuildPhase;
  artifact: unknown;
  expectedParentHash?: string;
  reason?: string;
}): { state: LoopBuildState; envelope: ArtifactEnvelope; invalidatedPhases: BuildPhase[] } {
  const state = loopBuildStateSchema.parse(input.state);
  const phaseIndex = BUILD_PHASES.indexOf(input.phase);
  const currentIndex = BUILD_PHASES.indexOf(state.buildPhase);
  if (phaseIndex > currentIndex) {
    throw new BuildStateError(BUILD_ERROR_CODES.INVALID_TRANSITION, `Cannot commit ${input.phase} while phase is ${state.buildPhase}`);
  }
  const payload = artifactPayloadSchemas[input.phase].parse(input.artifact);
  const parentPhase = phaseIndex > 0 ? BUILD_PHASES[phaseIndex - 1] : undefined;
  const parent = parentPhase ? state.artifacts[parentPhase] : undefined;
  if (parentPhase && !parent) {
    throw new BuildStateError(BUILD_ERROR_CODES.INVALID_TRANSITION, `${input.phase} requires ${parentPhase}`);
  }
  if (input.expectedParentHash !== undefined && input.expectedParentHash !== parent?.artifactHash) {
    throw new BuildStateError(BUILD_ERROR_CODES.STALE_PARENT, `Parent artifact for ${input.phase} is stale`);
  }
  if (input.phase === "connectors") {
    const blueprint = blueprintArtifactSchema.parse(parent?.artifact);
    const connectors = connectorArtifactSchema.parse(payload);
    const validIds = new Set(blueprint.taskBlueprint.outcomes.filter((row) => row.role !== "transform").map((row) => row.id));
    const selectedIds = new Set<string>();
    for (const selection of connectors.selections) {
      if (!validIds.has(selection.outcomeId) || selectedIds.has(selection.outcomeId)) {
        throw new BuildStateError(BUILD_ERROR_CODES.INVALID_TRANSITION, `Invalid or duplicate connector outcome ${selection.outcomeId}`);
      }
      selectedIds.add(selection.outcomeId);
    }
    if ([...validIds].some((id) => !selectedIds.has(id))) {
      throw new BuildStateError(BUILD_ERROR_CODES.USER_CONFIRMATION_REQUIRED, "Every non-transform blueprint outcome requires an explicit connector choice");
    }
  }
  if (input.phase === "bindings") {
    const connectors = connectorArtifactSchema.parse(parent?.artifact);
    const binding = bindingArtifactSchema.parse(payload);
    const selected = new Set(connectors.selections.map((row) => row.connector.toLowerCase()));
    const invalid = binding.bindings.find((row) => row.role !== "transform" && !selected.has(row.connector.toLowerCase()));
    if (invalid) throw new BuildStateError(BUILD_ERROR_CODES.UNSELECTED_CONNECTOR, `Binding uses unselected connector ${invalid.connector}`);
  }
  if (input.phase === "review" && reviewArtifactSchema.parse(payload).bindingHash !== parent?.artifactHash) {
    throw new BuildStateError(BUILD_ERROR_CODES.STALE_PARENT, "Review does not confirm the current binding artifact");
  }
  if (input.phase === "compile" && compileArtifactSchema.parse(payload).reviewHash !== parent?.artifactHash) {
    throw new BuildStateError(BUILD_ERROR_CODES.STALE_PARENT, "Compiled plan does not reference the current review");
  }
  if (input.phase === "test" && testArtifactSchema.parse(payload).compileHash !== parent?.artifactHash) {
    throw new BuildStateError(BUILD_ERROR_CODES.PLAN_MISMATCH, "Test does not reference the current compiled plan artifact");
  }
  if (input.phase === "activation" && activationArtifactSchema.parse(payload).testHash !== parent?.artifactHash) {
    throw new BuildStateError(BUILD_ERROR_CODES.PLAN_MISMATCH, "Activation does not reference the current passing test");
  }
  const previous = state.artifacts[input.phase];
  const artifactHash = hashArtifact(payload);
  if (previous?.artifactHash === artifactHash) {
    return { state, envelope: previous, invalidatedPhases: [] };
  }
  const envelope = artifactEnvelopeSchema.parse({
    id: randomUUID(), phase: input.phase, revision: (previous?.revision ?? 0) + 1,
    ...(parent ? { parentRevision: parent.revision, parentHash: parent.artifactHash } : {}),
    artifactHash, artifact: payload, createdAt: new Date().toISOString(),
  });
  const invalidatedPhases = BUILD_PHASES.slice(phaseIndex + 1).filter((phase) => Boolean(state.artifacts[phase]));
  const artifacts = { ...state.artifacts, [input.phase]: envelope };
  for (const phase of BUILD_PHASES.slice(phaseIndex + 1)) delete artifacts[phase];
  const nextPhase = BUILD_PHASES[Math.min(phaseIndex + 1, BUILD_PHASES.length - 1)];
  return {
    envelope,
    invalidatedPhases,
    state: loopBuildStateSchema.parse({
      buildPhase: nextPhase,
      artifacts,
      invalidations: invalidatedPhases.length === 0 ? state.invalidations : [...state.invalidations, {
        reason: input.reason ?? `${input.phase} artifact revised`,
        invalidatedAt: new Date().toISOString(), fromPhase: input.phase, phases: invalidatedPhases,
      }],
    }),
  };
}

export function assembleLoopSpec(state: LoopBuildState): LoopSpec {
  const parsed = loopBuildStateSchema.parse(state);
  const intent = intentArtifactSchema.parse(parsed.artifacts.intent?.artifact);
  const blueprint = blueprintArtifactSchema.parse(parsed.artifacts.blueprint?.artifact);
  const connectors = connectorArtifactSchema.parse(parsed.artifacts.connectors?.artifact);
  const bindings = bindingArtifactSchema.parse(parsed.artifacts.bindings?.artifact);
  const selected = new Map(connectors.selections.map((row) => [row.outcomeId, row.connector]));
  const selectedConnectors = new Set(connectors.selections.map((row) => row.connector.toLowerCase()));
  const invalidBinding = bindings.bindings.find((row) => row.role !== "transform" && !selectedConnectors.has(row.connector.toLowerCase()));
  if (invalidBinding) throw new BuildStateError(BUILD_ERROR_CODES.UNSELECTED_CONNECTOR, `Binding uses unselected connector ${invalidBinding.connector}`);
  const taskBlueprint = {
    ...blueprint.taskBlueprint,
    outcomes: blueprint.taskBlueprint.outcomes.map((row) => selected.has(row.id)
      ? { ...row, selectedConnector: selected.get(row.id), status: "chosen" as const }
      : row),
  };
  const spec: LoopSpec = {
    workspaceId: intent.workspaceId, intent: intent.intent, trigger: bindings.trigger,
    profile: blueprint.profile, bindings: bindings.bindings, composioActions: bindings.composioActions,
    taskBlueprint, intentDiscovery: { status: "confirmed", analysis: intent.analysis, decisions: [], askedQuestionIds: [] },
    agent: blueprint.agent, monitor: blueprint.monitor, sync: blueprint.sync, output: bindings.output,
    approval: blueprint.approval, guardrails: blueprint.guardrails,
  };
  spec.intentDiscovery.confirmedBriefHash = computeOutcomeBriefHash(spec);
  return spec;
}

/** Read-only projection for prompts/UI. It is never persisted as builder state. */
export function projectLoopSpec(state: LoopBuildState): LoopSpec {
  const parsed = loopBuildStateSchema.parse(state);
  const intent = parsed.artifacts.intent
    ? intentArtifactSchema.parse(parsed.artifacts.intent.artifact)
    : undefined;
  const blueprint = parsed.artifacts.blueprint
    ? blueprintArtifactSchema.parse(parsed.artifacts.blueprint.artifact)
    : undefined;
  const connectors = parsed.artifacts.connectors
    ? connectorArtifactSchema.parse(parsed.artifacts.connectors.artifact)
    : undefined;
  const binding = parsed.artifacts.bindings
    ? bindingArtifactSchema.parse(parsed.artifacts.bindings.artifact)
    : undefined;
  const selected = new Map((connectors?.selections ?? []).map((row) => [row.outcomeId, row.connector]));
  const taskBlueprint = blueprint?.taskBlueprint ? {
    ...blueprint.taskBlueprint,
    outcomes: blueprint.taskBlueprint.outcomes.map((row) => selected.has(row.id)
      ? { ...row, selectedConnector: selected.get(row.id), status: "chosen" as const }
      : row),
  } : undefined;
  const spec: LoopSpec = {
    workspaceId: intent?.workspaceId ?? "00000000-0000-0000-0000-000000000000",
    intent: intent?.intent ?? { goal: "Draft loop", outcome: "Draft outcome", successCriteria: [] },
    trigger: binding?.trigger ?? { kind: "manual" },
    profile: blueprint?.profile ?? "agentic",
    bindings: binding?.bindings ?? [], composioActions: binding?.composioActions ?? [], taskBlueprint,
    intentDiscovery: {
      status: parsed.artifacts.review ? "confirmed" : parsed.buildPhase === "intent" ? "pending" : "ready",
      analysis: intent?.analysis, decisions: [], askedQuestionIds: [],
    },
    agent: blueprint?.agent, monitor: blueprint?.monitor, sync: blueprint?.sync,
    output: binding?.output ?? { kind: "none" },
    approval: blueprint?.approval ?? { mode: "mixed", sensitiveRoles: [], sensitiveCapabilities: [], defaultTimeoutHours: 24, onTimeout: "reject" },
    guardrails: blueprint?.guardrails ?? { allowedTools: [], deniedTools: [], maxRetriesPerStep: 3, maxRunDurationMinutes: 60 },
  };
  if (parsed.artifacts.review) spec.intentDiscovery.confirmedBriefHash = computeOutcomeBriefHash(spec);
  return spec;
}

export function buildCommandResult(state: LoopBuildState, envelope: ArtifactEnvelope, invalidatedPhases: BuildPhase[]) {
  return { envelope, resultingPhase: state.buildPhase, userFacingStage: userFacingStageForPhase(state.buildPhase), invalidatedPhases };
}
