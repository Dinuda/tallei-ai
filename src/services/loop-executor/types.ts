import { z } from "zod";

export const LOOP_DEFINITION_VERSION = "loop_executor_v2";

/** @deprecated v1 semantic tool keys — kept for reading legacy task rows */
export const loopToolKeySchema = z.enum([
  "research_topic",
  "write_draft",
  "prepare_publication_plan",
]);

export type LoopToolKey = z.infer<typeof loopToolKeySchema>;

export const loopToolAssignmentSchema = z.object({
  ref: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

export type LoopToolAssignment = z.infer<typeof loopToolAssignmentSchema>;

export const loopRunAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  tools: z.array(loopToolAssignmentSchema).default([]),
});

export type LoopRunAgent = z.infer<typeof loopRunAgentSchema>;

export const ceoStrategyOutputSchema = z.object({
  strategyText: z.string().min(1),
  agents: z.array(loopRunAgentSchema).min(1).max(6),
});

export type CeoStrategyOutput = z.infer<typeof ceoStrategyOutputSchema>;

export const loopArtifactDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
});

export type LoopArtifactDefinition = z.infer<typeof loopArtifactDefinitionSchema>;

export const loopAgentStageSchema = z.object({
  kind: z.literal("agent"),
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  toolRef: z.string().min(1).nullable(),
  outputArtifactId: z.string().min(1).optional(),
});

export const loopApprovalGateStageSchema = z.object({
  kind: z.literal("approval_gate"),
  id: z.string().min(1),
  label: z.string().min(1),
  artifactId: z.string().min(1),
  required: z.literal(true),
});

export const loopInputGateStageSchema = z.object({
  kind: z.literal("input_gate"),
  id: z.string().min(1),
  label: z.string().min(1),
  inputSchema: z.record(z.unknown()).default({}),
  outputArtifactId: z.string().min(1),
});

export const loopExternalActionStageSchema = z.object({
  kind: z.literal("external_action"),
  id: z.string().min(1),
  label: z.string().min(1),
  toolRef: z.string().min(1),
  inputArtifactIds: z.array(z.string().min(1)).default([]),
});

export const loopStageSchema = z.discriminatedUnion("kind", [
  loopAgentStageSchema,
  loopApprovalGateStageSchema,
  loopInputGateStageSchema,
  loopExternalActionStageSchema,
]);

export type LoopStage = z.infer<typeof loopStageSchema>;

export const loopPlanSchema = z.object({
  goal: z.string().min(1),
  stages: z.array(loopStageSchema).min(1).max(24),
  artifacts: z.array(loopArtifactDefinitionSchema).default([]),
  allowedToolRefs: z.array(z.string().min(1)).default([]),
  allowedIntegrations: z.array(z.string().min(1)).default(["internal"]),
});

export type LoopPlan = z.infer<typeof loopPlanSchema>;

export const loopAgentGraphChildSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  tools: z.array(loopToolAssignmentSchema).default([]),
  connectorProvider: z.string().min(1).nullable().default(null),
  requestedToolkits: z.array(z.string().min(1)).default([]),
  outputArtifactId: z.string().min(1).optional(),
  outputArtifactKind: z.string().min(1).optional(),
});

export type LoopAgentGraphChild = z.infer<typeof loopAgentGraphChildSchema>;

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
  agentGraph: loopAgentGraphSchema.optional(),
  plan: loopPlanSchema.optional(),
  template: z.object({
    id: z.string().min(1),
    label: z.string().min(1),
  }).optional(),
});

export type LoopDefinition = z.infer<typeof loopDefinitionSchema>;

export const loopContactRowSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

export type LoopContactRow = z.infer<typeof loopContactRowSchema>;

export const loopExecutorRunMetaSchema = z.object({
  proposedRoster: z.array(loopRunAgentSchema).optional(),
  approvedRoster: z.array(loopRunAgentSchema).optional(),
  strategyReadyAt: z.string().optional(),
  rosterApprovedAt: z.string().optional(),
  approvalRequest: z.object({
    to: z.string(),
    approvalUrl: z.string(),
    token: z.string(),
    sentAt: z.string(),
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
  publicistApproval: z.object({
    to: z.string(),
    approvalUrl: z.string(),
    token: z.string(),
    sentAt: z.string(),
  }).optional(),
  emailApprovedAt: z.string().optional(),
  uiApprovedAt: z.string().optional(),
  approvalChannel: z.string().optional(),
  newsletterBody: z.string().optional(),
  contactList: z.object({
    uploadedAt: z.string(),
    contacts: z.array(loopContactRowSchema),
    recipientCount: z.number().int().nonnegative(),
  }).optional(),
  distribution: z.object({
    startedAt: z.string().optional(),
    retryStartedAt: z.string().optional(),
    sentAt: z.string(),
    successCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    recipientCount: z.number().int().nonnegative().optional(),
    nextIndex: z.number().int().nonnegative().optional(),
    batchSize: z.number().int().positive().optional(),
    recipients: z.array(z.object({
      email: z.string().email(),
      ok: z.boolean(),
      status: z.number().int().optional(),
      providerMessageId: z.string().optional(),
      error: z.string().optional(),
    })).optional(),
  }).optional(),
  deliveryAction: z.object({
    kind: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "partial_failure"]).default("pending"),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    successCount: z.number().int().nonnegative().optional(),
    failureCount: z.number().int().nonnegative().optional(),
    recipientCount: z.number().int().nonnegative().optional(),
  }).optional(),
});

export type LoopExecutorRunMeta = z.infer<typeof loopExecutorRunMetaSchema>;

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
