import { z } from "zod";

export const connectorSetupStageSchema = z.enum([
  "auth",
  "goals",
  "graph",
  "operations",
  "policies",
  "test",
  "complete",
]);

export const connectorBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.unknown() }),
  z.object({ kind: z.literal("runtime_channel"), channelKey: z.string().min(1), prompt: z.string().min(1).optional() }),
  z.object({ kind: z.literal("parent_context"), path: z.string().min(1) }),
  z.object({ kind: z.literal("sub_agent_output"), subAgentId: z.string().min(1), path: z.string().min(1) }),
  z.object({ kind: z.literal("trigger_payload"), path: z.string().min(1) }),
]);

export const connectorOperationSchema = z.object({
  id: z.string().min(1),
  toolRef: z.string().min(1),
  actionSlug: z.string().min(1),
  name: z.string().min(1).optional(),
  plannerRole: z.enum(["read", "draft", "publish"]),
  inputBindings: z.record(connectorBindingSchema).default({}),
  outputSchema: z.record(z.unknown()).default({}),
  approvalPolicy: z.object({
    required: z.boolean(),
    reason: z.string().optional(),
  }),
  dependsOn: z.array(z.string().min(1)).default([]),
});

export const connectorSubAgentSchema = z.object({
  id: z.string().min(1),
  parentAgentId: z.string().min(1),
  goal: z.string().min(1),
  toolkit: z.string().min(1),
  accountId: z.string().min(1).optional(),
  operations: z.array(connectorOperationSchema).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  handoffOutputs: z.array(z.object({
    path: z.string().min(1),
    description: z.string().min(1).optional(),
  })).default([{ path: "/" }]),
  testStatus: z.enum(["not_run", "passed", "failed", "skipped", "unavailable"]).default("not_run"),
});

export const connectorParentAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  toolkits: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  subAgents: z.array(connectorSubAgentSchema).default([]),
  successCriteria: z.array(z.string().min(1)).default([]),
  failurePolicy: z.string().min(1).default("Pause and ask the operator when connector output is missing or ambiguous."),
});

export const connectorAgentPlanSchema = z.object({
  parentAgents: z.array(connectorParentAgentSchema).default([]),
});

export const connectorSetupStateSchema = z.object({
  version: z.literal("v1"),
  requirementId: z.string().min(1),
  stage: connectorSetupStageSchema,
  selectedAccounts: z.record(z.array(z.string().min(1))).default({}),
  selectedActions: z.array(z.object({
    toolkit: z.string().min(1),
    actionSlug: z.string().min(1),
    toolRef: z.string().min(1),
  })).default([]),
  agentPlan: connectorAgentPlanSchema.default({ parentAgents: [] }),
  testRun: z.object({
    status: z.enum(["not_run", "passed", "failed", "skipped", "unavailable"]),
    checkedAt: z.string().min(1),
    errors: z.array(z.string()).default([]),
  }).optional(),
  warnings: z.array(z.string()).default([]),
  updatedAt: z.string().min(1),
});

export type ConnectorBinding = z.infer<typeof connectorBindingSchema>;
export type ConnectorOperation = z.infer<typeof connectorOperationSchema>;
export type ConnectorSubAgent = z.infer<typeof connectorSubAgentSchema>;
export type ConnectorParentAgent = z.infer<typeof connectorParentAgentSchema>;
export type ConnectorAgentPlan = z.infer<typeof connectorAgentPlanSchema>;
export type ConnectorSetupState = z.infer<typeof connectorSetupStateSchema>;

export function normalizeConnectorSetupState(value: unknown): ConnectorSetupState | null {
  if (value == null) return null;
  return connectorSetupStateSchema.parse(value);
}
