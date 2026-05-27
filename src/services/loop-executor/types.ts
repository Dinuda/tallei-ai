import { z } from "zod";

export const LOOP_DEFINITION_VERSION = "loop_executor_v1";

export const loopToolKeySchema = z.enum([
  "research_topic",
  "write_draft",
  "prepare_publication_plan",
]);

export type LoopToolKey = z.infer<typeof loopToolKeySchema>;

export const loopAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  integration: z.string().min(1),
  toolPolicy: z.object({
    allowedTools: z.array(loopToolKeySchema).length(1),
    draftBeforeExternalAction: z.boolean().default(true),
  }),
});

export type LoopAgentDefinition = z.infer<typeof loopAgentSchema>;

export const loopDefinitionSchema = z.object({
  definitionVersion: z.literal(LOOP_DEFINITION_VERSION),
  goal: z.string().min(1),
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }),
  schedulerTarget: z.enum(["internal", "cloudflare"]).default("internal"),
  integrations: z.array(z.string().min(1)).default(["internal"]),
  ceo: z.object({
    name: z.string().default("CEO"),
    task: z.string().min(1),
    policy: z.string().min(1),
  }),
  agents: z.array(loopAgentSchema).min(1),
  draftPolicy: z.object({
    requireDraftBeforeExternalAction: z.boolean().default(true),
    approvalRequiredFor: z.array(z.string()).default(["publish", "send", "external_action"]),
  }),
});

export type LoopDefinition = z.infer<typeof loopDefinitionSchema>;

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
