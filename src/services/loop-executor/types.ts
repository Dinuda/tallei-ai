/**
 * types.ts — Zod schemas and TypeScript types for loop executor v2.
 *
 * A **loop definition** is the persisted blueprint (goal, schedule, plan, tools).
 * **Run metadata** (`loopExecutorRunMetaSchema`) holds per-run state (roster, approvals, delivery).
 */

import { z } from "zod";
import { connectorPolicySchema, noSlopSpecSnapshotSchema } from "../loop-engine/spec-contracts.js";
import { inputRequirementSchema } from "../loop-engine/input-surfaces.js";
import { workflowUserProfileSchema } from "../loop-engine/workflow-user-profile.js";
import { dataContractSchema, normalizeContractSchema } from "../loop-engine/data-contract.js";
import { operatorInteractionPlanSchema } from "../loop-engine/operator-interactions.js";

/** Normalize null/blank optional strings to omitted so LLM/client payloads validate. */
export function normalizeOptionalString(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return typeof value === "string" ? value.trim() : value;
}

export const optionalNonEmptyStringSchema = z.preprocess(
  normalizeOptionalString,
  z.string().min(1).optional(),
);

/** Current loop definition schema version stored on `workflows.definition_version`. */
export const LOOP_DEFINITION_VERSION = "loop_executor_v2";

/** Agentic loop engine generation — preset-free design + gated controller runs. */
export const LOOP_ENGINE_VERSION = "loop_engine_v3";

export const loopGateTypeSchema = z.string();
export type LoopGateType = string;
export const loopAgentGateSchema = z.object({ type: loopGateTypeSchema, question: z.string().min(1) });

export const loopAgentContractSchema = z.preprocess((val) => {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (obj.schema && typeof obj.schema === "object" && !Array.isArray(obj.schema)) {
      return {
        ...obj,
        schema: normalizeContractSchema(obj.schema as Record<string, unknown>),
      };
    }
  }
  return val;
}, dataContractSchema);

export type LoopAgentContract = z.infer<typeof loopAgentContractSchema>;

export const agentHandoffBindingSchema = z.object({
  source: z.object({
    kind: z.enum(["agent_output", "operator_input", "stable_config", "artifact"]),
    agentId: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    path: z.string().min(1).default("/"),
  }),
  targetPath: z.string().min(1),
  required: z.boolean().default(true),
  valuePolicy: z.enum(["derivable", "passthrough"]).optional(),
  provenance: z.enum(["agent_output", "operator_input", "stable_config", "artifact", "connector_output"]).optional(),
  transformation: z.enum(["direct", "merge", "transform"]).default("direct").optional(),
});

export type AgentHandoffBinding = z.infer<typeof agentHandoffBindingSchema>;

export const loopDeliveryRoutingSchema = z.object({
  provider: z.string().min(1),
});

export type LoopDeliveryRouting = z.infer<typeof loopDeliveryRoutingSchema>;

/** Tool binding on an agent: catalog ref plus optional JSON config. */
export const loopToolAssignmentSchema = z.object({
  ref: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

export type LoopToolAssignment = z.infer<typeof loopToolAssignmentSchema>;

/** One specialist agent in a run roster or task row. */
export const loopRunAgentSchema = z.object({
  nodeKind: z.enum(["agent", "transform", "operator_input", "action", "checkpoint"]).optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  goal: z.string().min(1).optional(),
  tools: z.array(loopToolAssignmentSchema).default([]),
  doneCriteria: z.array(z.string().min(1)).default([]).optional(),
  inputContract: loopAgentContractSchema.optional(),
  outputContract: loopAgentContractSchema.optional(),
  handoffBindings: z.array(agentHandoffBindingSchema).default([]),
  gate: loopAgentGateSchema.optional(),
  outputArtifactId: z.string().min(1).optional(),
});

export type LoopRunAgent = z.infer<typeof loopRunAgentSchema>;

/** CEO strategy heartbeat output (before human approval). */
export const ceoStrategyOutputSchema = z.object({
  strategyText: z.string().min(1),
  agents: z.array(loopRunAgentSchema).min(1).max(6),
});

export type CeoStrategyOutput = z.infer<typeof ceoStrategyOutputSchema>;

/** Declared artifact in a dynamic plan. */
export const loopArtifactDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
});

export type LoopArtifactDefinition = z.infer<typeof loopArtifactDefinitionSchema>;

const LOOP_STAGE_APPROVAL_CHANNEL_VALUES = ["primary", "email", "gmail", "telegram", "whatsapp"] as const;

export const loopStageApprovalChannelSchema = z.enum(LOOP_STAGE_APPROVAL_CHANNEL_VALUES);
export type LoopStageApprovalChannel = z.infer<typeof loopStageApprovalChannelSchema>;

const LOOP_STAGE_APPROVAL_CHANNEL_SET = new Set<LoopStageApprovalChannel>(LOOP_STAGE_APPROVAL_CHANNEL_VALUES);

export function normalizeLoopStageApprovalChannel(value: string): LoopStageApprovalChannel | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return null;

  if (LOOP_STAGE_APPROVAL_CHANNEL_SET.has(normalized as LoopStageApprovalChannel)) {
    return normalized as LoopStageApprovalChannel;
  }

  const wordMatch = normalized.match(/\b(primary|email|gmail|telegram|whatsapp)\b/);
  if (wordMatch) {
    return wordMatch[1] as LoopStageApprovalChannel;
  }

  if (/\b(resend|broadcast|inbox)\b/.test(normalized)) {
    return "email";
  }

  return null;
}

export const loopStageApprovalChannelInputSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return normalizeLoopStageApprovalChannel(value) ?? value.trim().toLowerCase();
}, loopStageApprovalChannelSchema);

export const loopStageApprovalPolicySchema = z.object({
  required: z.boolean().default(false),
  mode: z.enum(["before", "after", "manual_gate"]).default("manual_gate"),
  channels: z.array(loopStageApprovalChannelInputSchema).min(1).default(["primary"]),
  onReject: z.enum(["block", "revise", "skip_stage"]).default("block"),
  artifactRef: z.string().min(1).optional(),
});

export type LoopStageApprovalPolicy = z.infer<typeof loopStageApprovalPolicySchema>;

/** Plan stage: run one agent. */
export const loopAgentStageSchema = z.object({
  kind: z.literal("agent"),
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  toolRef: z.string().min(1).nullable(),
  outputArtifactId: z.string().min(1).optional(),
  approvalPolicy: loopStageApprovalPolicySchema.optional(),
});

/** Plan stage: pause for human approval on an artifact. */
export const loopApprovalGateStageSchema = z.object({
  kind: z.literal("approval_gate"),
  id: z.string().min(1),
  label: z.string().min(1),
  artifactId: z.string().min(1),
  required: z.literal(true),
  approvalPolicy: loopStageApprovalPolicySchema.default({
    required: true,
    mode: "manual_gate",
    channels: ["primary"],
    onReject: "block",
  }),
});

/** Plan stage: pause for structured operator input. */
export const loopInputGateStageSchema = z.object({
  kind: z.literal("input_gate"),
  id: z.string().min(1),
  label: z.string().min(1),
  inputSchema: z.record(z.unknown()).default({}),
  outputArtifactId: z.string().min(1),
  approvalPolicy: loopStageApprovalPolicySchema.optional(),
});

/** Plan stage: execute a catalog external-action tool (e.g. broadcast). */
export const loopExternalActionStageSchema = z.object({
  kind: z.literal("external_action"),
  id: z.string().min(1),
  label: z.string().min(1),
  toolRef: z.string().min(1),
  inputArtifactIds: z.array(z.string().min(1)).default([]),
  approvalPolicy: loopStageApprovalPolicySchema.default({
    required: true,
    mode: "before",
    channels: ["primary"],
    onReject: "block",
  }),
});

export const loopStageSchema = z.discriminatedUnion("kind", [
  loopAgentStageSchema,
  loopApprovalGateStageSchema,
  loopInputGateStageSchema,
  loopExternalActionStageSchema,
]);

export type LoopStage = z.infer<typeof loopStageSchema>;
export type LoopExternalActionStage = z.infer<typeof loopExternalActionStageSchema>;
export type LoopInputGateStage = z.infer<typeof loopInputGateStageSchema>;

/** Ordered stages and artifacts for plan-driven runs. */
export const loopPlanSchema = z.object({
  goal: z.string().min(1),
  stages: z.array(loopStageSchema).min(1).max(24),
  artifacts: z.array(loopArtifactDefinitionSchema).default([]),
  allowedToolRefs: z.array(z.string().min(1)).default([]),
  allowedIntegrations: z.array(z.string().min(1)).default(["internal"]),
});

export type LoopPlan = z.infer<typeof loopPlanSchema>;

/** Child agent in the design-time agent graph (optional at create time). */
export const loopAgentGraphChildSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodeKind: z.enum(["agent", "transform", "operator_input", "action", "checkpoint"]).optional(),
  task: z.string().min(1),
  goal: z.string().min(1).optional(),
  tools: z.array(loopToolAssignmentSchema).default([]),
  doneCriteria: z.array(z.string().min(1)).default([]).optional(),
  inputContract: loopAgentContractSchema.optional(),
  outputContract: loopAgentContractSchema.optional(),
  handoffBindings: z.array(agentHandoffBindingSchema).default([]),
  gate: loopAgentGateSchema.optional(),
  outputArtifactId: z.string().min(1).optional(),
  outputArtifactKind: z.string().min(1).optional(),
});

export type LoopAgentGraphChild = z.infer<typeof loopAgentGraphChildSchema>;

/** Parent coordinator plus optional pre-defined children. */
export const loopAgentGraphSchema = z.object({
  parent: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    task: z.string().min(1),
    policy: z.string().min(1),
    connectorHub: z.object({
      provider: z.literal("composio"),
      label: z.string().min(1),
      description: z.string().min(1),
    }).optional(),
  }),
  children: z.array(loopAgentGraphChildSchema).max(12).default([]),
});

export type LoopAgentGraph = z.infer<typeof loopAgentGraphSchema>;

/**
 * Persisted loop definition (`workflows.metadata_json.loopDefinition`).
 */
export const loopDefinitionSchema = z.object({
  definitionVersion: z.literal(LOOP_DEFINITION_VERSION),
  goal: z.string().min(1),
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }),
  schedulerTarget: z.enum(["internal", "cloudflare"]).default("internal"),
  allowedIntegrations: z.array(z.string().min(1)).default(["internal"]),
  allowedToolRefs: z.array(z.string().min(1)).optional(),
  ceo: z.object({
    name: z.string().default("CEO"),
    task: z.string().min(1),
    policy: z.string().min(1),
  }),
  draftPolicy: z.object({
    requireDraftBeforeExternalAction: z.boolean().default(true),
    approvalRequiredFor: z.array(z.string()).default(["publish", "send", "external_action"]),
  }),
  deliveryType: optionalNonEmptyStringSchema,
  /** LLM-chosen delivery routing for the agentic engine (replaces regex classification). */
  delivery: loopDeliveryRoutingSchema.optional(),
  connectorPolicy: connectorPolicySchema.optional(),
  inputRequirements: z.array(inputRequirementSchema).default([]).optional(),
  operatorInteractionPlan: operatorInteractionPlanSchema.optional(),
  engineVersion: z.literal(LOOP_ENGINE_VERSION).optional(),
  agentGraph: loopAgentGraphSchema,
  plan: loopPlanSchema.optional(),
  builderMeta: z.object({
    designedBy: z.enum(["ceo_llm", "loop_architect"]).default("ceo_llm"),
    engineVersion: z.literal(LOOP_ENGINE_VERSION).optional(),
    preApproved: z.boolean().default(true),
    sourceTemplateIds: z.array(z.string()).optional(),
    model: z.string().optional(),
    noSlopSpec: noSlopSpecSnapshotSchema.optional(),
    agentSpecGeneration: z.object({
      mode: z.literal("hybrid"),
      model: z.string().optional(),
      generatedAt: z.string().min(1),
    }).optional(),
    designDiagnostics: z.record(z.unknown()).optional(),
    discoveredToolContracts: z.array(z.record(z.unknown())).optional(),
    planningIRVersion: z.string().optional(),
    planningIR: z.record(z.unknown()).optional(),
    workflowUserProfile: workflowUserProfileSchema.optional(),
    workflowBuilderSessionId: z.string().uuid().optional(),
  }).optional(),
});

export type LoopDefinition = z.infer<typeof loopDefinitionSchema>;

/** Email + optional name for bulk delivery recipient lists. */
export const loopContactRowSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

export type LoopContactRow = z.infer<typeof loopContactRowSchema>;

/**
 * Per-run executor state under `workflow_runs.metadata_json.loop_executor`.
 */
export const loopExecutorRunMetaSchema = z.object({
  proposedRoster: z.array(loopRunAgentSchema).optional(),
  approvedRoster: z.array(loopRunAgentSchema).optional(),
  strategyReadyAt: z.string().optional(),
  rosterApprovedAt: z.string().optional(),
  deliveryAgentTaskId: z.string().optional(),
  designDiagnostics: z.record(z.unknown()).optional(),
  approvalRequest: z.object({
    to: z.string(),
    approvalUrl: z.string(),
    token: z.string(),
    sentAt: z.string().optional(),
    reservedAt: z.string().optional(),
    channel: z.string().optional(),
    artifactKind: z.string().optional(),
  }).optional(),
  approvalDecision: z.object({
    approvedAt: z.string(),
    channel: z.string(),
  }).optional(),
  pendingInput: z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    status: z.enum(["pending", "submitted"]).default("pending"),
    requestedAt: z.string(),
    submittedAt: z.string().optional(),
    instructions: z.string().optional(),
    schema: z.record(z.unknown()).optional(),
  }).optional(),
  artifactBody: z.string().optional(),
  deliveryContentBody: z.string().optional(),
  deliveryContentArtifactId: z.string().optional(),
  deliveryResultArtifactId: z.string().optional(),
  deliveryRecipients: z.object({
    uploadedAt: z.string(),
    contacts: z.array(loopContactRowSchema),
    recipientCount: z.number().int().nonnegative(),
    documentRef: z.string().optional(),
    lotRef: z.string().optional(),
  }).optional(),
  deliveryTemplateId: z.string().optional(),
  deliveryEmailHtml: z.string().optional(),
  deliveryEmailDesign: z.unknown().optional(),
  deliveryEmailUpdatedAt: z.string().optional(),
  deliveryEmailSource: z.string().optional(),
  emailTemplate: z.object({
    html: z.string().optional(),
    design: z.unknown().optional(),
    updatedAt: z.string().optional(),
  }).optional(),
  deliveryBatch: z.object({
    startedAt: z.string().optional(),
    retryStartedAt: z.string().optional(),
    sentAt: z.string().optional(),
    successCount: z.number().int().nonnegative().optional(),
    failureCount: z.number().int().nonnegative().optional(),
    openCount: z.number().int().nonnegative().optional(),
    clickCount: z.number().int().nonnegative().optional(),
    totalClickCount: z.number().int().nonnegative().optional(),
    deliveredCount: z.number().int().nonnegative().optional(),
    bounceCount: z.number().int().nonnegative().optional(),
    failedEventCount: z.number().int().nonnegative().optional(),
    complaintCount: z.number().int().nonnegative().optional(),
    unsubscribeCount: z.number().int().nonnegative().optional(),
    openRate: z.number().nonnegative().optional(),
    clickRate: z.number().nonnegative().optional(),
    metricsUpdatedAt: z.string().optional(),
    recipientCount: z.number().int().nonnegative().optional(),
    nextIndex: z.number().int().nonnegative().optional(),
    batchSize: z.number().int().positive().optional(),
    segmentId: z.string().optional(),
    broadcastId: z.string().optional(),
    broadcastError: z.string().optional(),
    dryRun: z.boolean().optional(),
    provider: z.string().optional(),
    metricsWebhook: z.object({
      id: z.string().nullable().optional(),
      endpoint: z.string().nullable().optional(),
      created: z.boolean().optional(),
      updated: z.boolean().optional(),
      events: z.array(z.string()).optional(),
    }).optional(),
    trackingDiagnostics: z.object({
      htmlBytes: z.number().int().nonnegative().optional(),
      textBytes: z.number().int().nonnegative().optional(),
      gmailClippingRisk: z.boolean().optional(),
      gmailClippingWarningBytes: z.number().int().positive().optional(),
      openTracking: z.string().optional(),
      note: z.string().optional(),
      webhookEndpoint: z.string().nullable().optional(),
    }).optional(),
    recipients: z.array(z.object({
      email: z.string().email(),
      ok: z.boolean(),
      status: z.number().int().optional(),
      contactId: z.string().optional(),
      providerMessageId: z.string().optional(),
      error: z.string().optional(),
    })).optional(),
  }).optional(),
  deliveryAction: z.object({
    kind: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "partial_failure", "syncing_contacts", "failed"]).default("pending"),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    successCount: z.number().int().nonnegative().optional(),
    failureCount: z.number().int().nonnegative().optional(),
    recipientCount: z.number().int().nonnegative().optional(),
    broadcastId: z.string().optional(),
  }).optional(),
  activeGateId: z.string().nullish(),
  activeGateStageId: z.string().nullish(),
  gateCompletedAt: z.string().optional(),
  blockedAt: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  resumedAt: z.string().optional(),
  rerunTaskId: z.string().optional(),
  rerunTaskSeq: z.number().optional(),
});

export type LoopExecutorRunMeta = z.infer<typeof loopExecutorRunMetaSchema>;

/** API view of a saved loop workflow. */
export interface LoopWorkflowView {
  id: string;
  workspaceId: string | null;
  title: string;
  status: string;
  scheduleRrule: string;
  nextRunAt: string | null;
  lastScheduledAt: string | null;
  definition: LoopDefinition;
  createdAt: string;
  updatedAt: string;
}

/** Runtime preset: optional fixed CEO roster for a domain workflow. */
export interface LoopPreset {
  id: string;
  label: string;
  buildRoster: (goal: string) => Promise<CeoStrategyOutput>;
}

/** Formats raw delivery body for a provider (e.g. email broadcast). */
export interface DeliveryContentFormatter {
  sanitizeBody(raw: string): string;
  formatForDelivery(raw: string): { subject: string | null; text: string; html: string };
  formatForBroadcast(
    formatted: { subject: string | null; text: string; html: string },
    options?: { templateId?: string | null; useReactEmail?: boolean }
  ): { text: string; html: string } | Promise<{ text: string; html: string }>;
}
