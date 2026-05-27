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
});

export type LoopDefinition = z.infer<typeof loopDefinitionSchema>;

export const loopExecutorRunMetaSchema = z.object({
  proposedRoster: z.array(loopRunAgentSchema).optional(),
  approvedRoster: z.array(loopRunAgentSchema).optional(),
  strategyReadyAt: z.string().optional(),
  rosterApprovedAt: z.string().optional(),
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
