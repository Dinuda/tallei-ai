import { z } from "zod";

export const WORKFLOW_DEFINITIONS = {
  DAILY_INTELLIGENCE: "dailyIntelligenceWorkflow",
  WORKFLOW_RUN: "workflowRunWorkflow",
} as const;

export const dailyIntelligenceWorkflowInputSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const workflowRunWorkflowInputSchema = z.object({
  runId: z.string().uuid(),
  workflowId: z.string().uuid(),
  runMode: z.enum(["scheduled", "manual"]),
  scheduledFor: z.string().nullable(),
});

export type DailyIntelligenceWorkflowInput = z.infer<typeof dailyIntelligenceWorkflowInputSchema>;
export type WorkflowRunWorkflowInput = z.infer<typeof workflowRunWorkflowInputSchema>;
