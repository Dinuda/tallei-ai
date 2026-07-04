import { z } from "zod";
import {
  confirmOutcomeBriefActionSchema,
  type ConfirmOutcomeBriefAction,
} from "./confirm-outcome-brief-action.js";
import { BUILD_PHASES, buildPhaseSchema } from "./build-state.js";
import { intentAnalysisSchema } from "./intent-discovery.js";

export const askQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  outcomeId: z.string().optional(),
  role: z.string().optional(),
  disabled: z.boolean().optional(),
});

export const askQuestionInputSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(askQuestionOptionSchema).min(2),
  recommendedOptionIds: z.array(z.string()).optional(),
  allowMultiple: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  step: z.object({
    index: z.number().int().min(1),
    total: z.number().int().min(1),
  }).optional(),
});

export const askQuestionOutputSchema = z.object({
  questionId: z.string().min(1),
  answerText: z.string().min(1),
  selectedOptionIds: z.array(z.string()),
  selectedValues: z.array(z.string()),
  otherText: z.string().optional(),
  skipped: z.boolean().optional(),
  outcomeId: z.string().min(1).optional(),
  role: z.enum(["trigger", "source", "transform", "destination"]).optional(),
});

export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;
export type AskQuestionOutput = z.infer<typeof askQuestionOutputSchema>;

/** Server-driven connector picker — options come from discoverConnectorsForBlueprint, not the model. */
export const pickConnectorAppInputSchema = z.object({
  outcomeId: z.string().min(1),
  role: z.enum(["trigger", "source", "destination"]),
}).strict();

export type PickConnectorAppInput = z.infer<typeof pickConnectorAppInputSchema>;

export const analyzeIntentInputSchema = intentAnalysisSchema;
export type AnalyzeIntentInput = z.infer<typeof analyzeIntentInputSchema>;

export const listTriggersInputSchema = z.object({
  toolkit: z.string().min(1),
});

export const listActionsInputSchema = z.object({
  toolkit: z.string().min(1),
});

export const connectToolkitInputSchema = z.object({
  toolkit: z.string().min(1),
  callbackUrl: z.string().url().optional(),
});

export const listWorkspaceConnectorsInputSchema = z.object({});

export { confirmOutcomeBriefActionSchema, type ConfirmOutcomeBriefAction };

const confirmOutcomeBriefPickerActionSchema = z.enum(["confirm", "other"]);

const confirmOutcomeBriefOptionSchema = askQuestionOptionSchema.extend({
  id: confirmOutcomeBriefPickerActionSchema,
  value: confirmOutcomeBriefPickerActionSchema,
});

const outcomeBriefHashSchema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 confirmation hash");

export const confirmOutcomeBriefInputSchema = z.object({
  briefHash: outcomeBriefHashSchema,
  question: z.string().min(1),
  options: z.array(confirmOutcomeBriefOptionSchema).length(2),
  recommendedOptionIds: z.array(z.string()).optional(),
  allowOther: z.literal(false).optional(),
});

export const confirmOutcomeBriefOutputSchema = z.object({
  action: confirmOutcomeBriefActionSchema,
  briefHash: outcomeBriefHashSchema,
  answerText: z.string().min(1),
  selectedOptionIds: z.array(z.string()),
  selectedValues: z.array(z.string()),
  otherText: z.string().optional(),
});

export function resolveConfirmOutcomeBriefAction(
  selectedValue: string,
): ConfirmOutcomeBriefAction {
  const parsed = confirmOutcomeBriefActionSchema.safeParse(selectedValue);
  return parsed.success ? parsed.data : "other";
}

export { resolveConfirmOutcomeBriefActionFromSelection } from "./confirm-outcome-brief-action.js";

export type ConfirmOutcomeBriefInput = z.infer<typeof confirmOutcomeBriefInputSchema>;
export type ConfirmOutcomeBriefOutput = z.infer<typeof confirmOutcomeBriefOutputSchema>;

/** Clickable quick-reply chips for conversational yes/no or next-step choices. */
export const presentReplyOptionsInputSchema = z.object({
  options: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    message: z.string().min(1),
  })).min(2).max(5),
});

export const presentReplyOptionsOutputSchema = z.object({
  selectedOptionId: z.string().min(1),
  message: z.string().min(1),
});

export type PresentReplyOptionsInput = z.infer<typeof presentReplyOptionsInputSchema>;
export type PresentReplyOptionsOutput = z.infer<typeof presentReplyOptionsOutputSchema>;

export const discoverBindingsInputSchema = z.object({
  toolkit: z.string().min(1),
}).strict();

export type DiscoverBindingsInput = z.infer<typeof discoverBindingsInputSchema>;

export const resolveBindingsInputSchema = z.object({}).strict();
export type ResolveBindingsInput = z.infer<typeof resolveBindingsInputSchema>;

export const discoverConnectorsForBlueprintInputSchema = z.object({
  outcomes: z.array(z.object({
    id: z.string().min(1),
    role: z.enum(["trigger", "source", "transform", "destination"]),
    description: z.string().min(1),
  })).min(1),
});

export type DiscoverConnectorsForBlueprintInput = z.infer<typeof discoverConnectorsForBlueprintInputSchema>;

export const conductorExecutionMetadataSchema = z.object({
  ok: z.boolean(),
  operationKey: z.string().min(1),
  phaseBefore: buildPhaseSchema,
  phaseAfter: buildPhaseSchema,
  phaseCompleted: z.boolean(),
  requiresUserInput: z.boolean(),
  retryAllowed: z.boolean(),
  parentArtifactHash: z.string().min(1),
  invalidatedPhases: z.array(buildPhaseSchema),
  error: z.string().min(1).optional(),
  recoverToPhase: buildPhaseSchema.optional(),
  recoverReason: z.string().min(1).optional(),
  resumeTool: z.string().min(1).optional(),
});

export type ConductorExecutionMetadata = z.infer<typeof conductorExecutionMetadataSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readConductorExecutionMetadata(value: unknown): ConductorExecutionMetadata | null {
  if (!isRecord(value)) return null;
  const candidate = {
    ok: value.ok,
    operationKey: value.operationKey,
    phaseBefore: value.phaseBefore,
    phaseAfter: value.phaseAfter,
    phaseCompleted: value.phaseCompleted,
    requiresUserInput: value.requiresUserInput,
    retryAllowed: value.retryAllowed,
    parentArtifactHash: value.parentArtifactHash,
    invalidatedPhases: value.invalidatedPhases,
    error: value.error,
    recoverToPhase: value.recoverToPhase,
    recoverReason: value.recoverReason,
    resumeTool: value.resumeTool,
  };
  const parsed = conductorExecutionMetadataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Prerequisite miss that redirects Conductor to an earlier phase in the same turn. */
export function isRecoverableConductorExecution(metadata: ConductorExecutionMetadata): boolean {
  return metadata.ok === false
    && metadata.retryAllowed === true
    && Boolean(metadata.recoverToPhase);
}

export function isConductorBuildPhase(value: unknown): value is z.infer<typeof buildPhaseSchema> {
  return typeof value === "string" && (BUILD_PHASES as readonly string[]).includes(value);
}

export const compileLoopInputSchema = z.object({});

export const activateLoopInputSchema = z.object({
  compiledPlanId: z.string().uuid().optional(),
  confirmedByUser: z.literal(true),
});

export type CompileLoopInput = z.infer<typeof compileLoopInputSchema>;
export type ActivateLoopInput = z.infer<typeof activateLoopInputSchema>;

export const testRunScenarioSchema = z.object({
  label: z.string().min(1),
  triggerPayload: z.record(z.unknown()).optional(),
  context: z.string().optional(),
});

export const testRunLoopInputSchema = z.object({
  compiledPlanId: z.string().uuid().optional(),
  scenario: testRunScenarioSchema,
});

export type TestRunScenario = z.infer<typeof testRunScenarioSchema>;
export type TestRunLoopInput = z.infer<typeof testRunLoopInputSchema>;

export {
  presentAgentTeamInputSchema,
  presentAgentTeamOutputSchema,
  type PresentAgentTeamInput,
  type PresentAgentTeamOutput,
  type AgentTeamSpecialist,
} from "./present-agent-team.js";
