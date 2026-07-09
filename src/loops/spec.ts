import { z } from "zod";

import { approvalSensitiveRoleSchema, intentDiscoveryStateSchema } from "./intent-discovery.js";


export const executionProfileSchema = z.enum(["agentic", "monitor", "sync"]);
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    cron: z.string().min(1),
    timezone: z.string().default("UTC"),
  }),
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("event"),
    source: z.string().min(1),
    composioSlug: z
      .string()
      .default("")
      .refine(
        (slug) => !slug.trim() || /^[A-Z][A-Z0-9_]+$/.test(slug.trim()),
        "composioSlug must be an uppercase Composio trigger slug, not the connector name",
      ),
    eventType: z.string().optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
]);
export type TriggerConfig = z.infer<typeof triggerSchema>;

export const toolBindingSchema = z.object({
  capability: z.string().min(1),
  connector: z.string().min(1),
  actionSlug: z.string().min(1).optional(),
  role: z.enum(["trigger", "source", "transform", "destination"]).optional(),
});
export type ToolBinding = z.infer<typeof toolBindingSchema>;

export const outcomeRoleSchema = z.enum(["trigger", "source", "transform", "destination"]);
export type OutcomeRole = z.infer<typeof outcomeRoleSchema>;

export const blueprintOutcomeSchema = z.object({
  id: z.string().min(1),
  role: outcomeRoleSchema,
  description: z.string().min(1),
  selectedConnector: z.string().min(1).optional(),
  status: z.enum(["pending", "chosen", "skipped"]).default("pending"),
}).superRefine((outcome, ctx) => {
  if (outcome.role !== "transform" && outcome.status === "chosen" && !outcome.selectedConnector) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "chosen connector outcomes require selectedConnector",
      path: ["selectedConnector"],
    });
  }
});

export const taskBlueprintSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  outcomes: z.array(blueprintOutcomeSchema).default([]),
});
export type TaskBlueprint = z.infer<typeof taskBlueprintSchema>;

export const agentConfigSchema = z.object({
  instructions: z.string().min(1),
  model: z.string().optional(),
  maxSteps: z.number().int().min(1).max(50).default(12),
  maxTokens: z.number().int().min(256).max(32_000).default(8_000),
  budgetUsd: z.number().min(0).optional(),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const monitorRuleSchema = z.object({
  op: z.enum(["gt", "lt", "eq", "gte", "lte"]),
  field: z.string().min(1),
  value: z.union([z.number(), z.string()]),
  windowMinutes: z.number().int().min(1).optional(),
});

export const monitorConfigSchema = z.object({
  source: z.string().min(1),
  rule: monitorRuleSchema,
  cooldownMinutes: z.number().int().min(0).default(15),
});
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;

export const syncConfigSchema = z.object({
  left: z.object({ connector: z.string(), object: z.string() }),
  right: z.object({ connector: z.string(), object: z.string() }),
  mapping: z.record(z.string()),
  conflictPolicy: z.enum(["newest_wins", "left_wins", "right_wins"]).default("newest_wins"),
  direction: z.enum(["left_to_right", "right_to_left", "bidirectional"]).default("bidirectional"),
});
export type SyncConfig = z.infer<typeof syncConfigSchema>;

export const outputConfigSchema = z.object({
  kind: z.enum(["chat", "email", "webhook", "none"]).default("none"),
  target: z.string().optional(),
  connector: z.string().optional(),
});
export type OutputConfig = z.infer<typeof outputConfigSchema>;

export const approvalPolicySchema = z.object({
  mode: z.enum(["auto", "ask", "mixed"]).default("mixed"),
  sensitiveRoles: z.array(approvalSensitiveRoleSchema).default([]),
  sensitiveCapabilities: z.array(z.string()).default([]),
  defaultTimeoutHours: z.number().min(1).max(168).default(24),
  onTimeout: z.enum(["reject", "escalate"]).default("reject"),
});
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const guardrailConfigSchema = z.object({
  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default([]),
  maxRetriesPerStep: z.number().int().min(0).max(10).default(3),
  maxRunDurationMinutes: z.number().int().min(1).max(24 * 60).default(60),
});
export type GuardrailConfig = z.infer<typeof guardrailConfigSchema>;

export const intentSchema = z.object({
  goal: z.string().min(1),
  outcome: z.string().min(1),
  successCriteria: z.array(z.string()).default([]),
});
export type LoopIntent = z.infer<typeof intentSchema>;

export const composioActionInputSourceSchema = z.object({
  type: z.enum(["trigger", "static", "previous_action", "user_config", "planner"]),
  path: z.string().min(1).optional(),
  value: z.unknown().optional(),
  actionSlug: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type ComposioActionInputSource = z.infer<typeof composioActionInputSourceSchema>;

export const composioActionInputInstructionSchema = z.object({
  field: z.string().min(1),
  required: z.boolean().optional(),
  description: z.string().optional(),
  sources: z.array(composioActionInputSourceSchema).default([]),
});
export type ComposioActionInputInstruction = z.infer<typeof composioActionInputInstructionSchema>;

export const composioActionOutputInstructionSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type ComposioActionOutputInstruction = z.infer<typeof composioActionOutputInstructionSchema>;

export const composioActionRequiredFieldSchema = z.object({
  field: z.string().min(1),
  type: z.string().min(1),
  description: z.string().optional(),
  source: z.string().min(1),
});

export const triggerOutputFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().optional(),
  optional: z.boolean().optional(),
});

export const composioActionInstructionSchema = z.object({
  toolkit: z.string().min(1),
  actionSlug: z.string().min(1),
  label: z.string().min(1).optional(),
  inputInstructions: z.array(composioActionInputInstructionSchema).default([]),
  outputInstructions: z.array(composioActionOutputInstructionSchema).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  requiredFields: z.array(composioActionRequiredFieldSchema).optional(),
  feasible: z.boolean().optional(),
});
export type ComposioActionInstruction = z.infer<typeof composioActionInstructionSchema>;

export const loopSpecSchema = z.object({
  workspaceId: z.string().uuid(),
  intent: intentSchema,
  trigger: triggerSchema,
  profile: executionProfileSchema.default("agentic"),
  bindings: z.array(toolBindingSchema).default([]),
  composioActions: z.array(composioActionInstructionSchema).default([]),
  triggerOutputFields: z.array(triggerOutputFieldSchema).optional(),
  taskBlueprint: taskBlueprintSchema.optional(),
  intentDiscovery: intentDiscoveryStateSchema.default({}),
  agent: agentConfigSchema.optional(),
  monitor: monitorConfigSchema.optional(),
  sync: syncConfigSchema.optional(),
  output: outputConfigSchema.default({ kind: "none" }),
  approval: approvalPolicySchema.default({}),
  guardrails: guardrailConfigSchema.default({}),
});
export type LoopSpec = z.infer<typeof loopSpecSchema>;

export const specPatchSchema = z.object({
  intent: intentSchema.partial().optional(),
  trigger: triggerSchema.optional(),
  profile: executionProfileSchema.optional(),
  bindings: z.array(toolBindingSchema).optional(),
  composioActions: z.array(composioActionInstructionSchema).optional(),
  triggerOutputFields: z.array(triggerOutputFieldSchema).optional(),
  taskBlueprint: taskBlueprintSchema.optional(),
  intentDiscovery: intentDiscoveryStateSchema.partial().optional(),
  agent: agentConfigSchema.partial().optional(),
  monitor: monitorConfigSchema.optional(),
  sync: syncConfigSchema.optional(),
  output: outputConfigSchema.partial().optional(),
  approval: approvalPolicySchema.partial().optional(),
  guardrails: guardrailConfigSchema.partial().optional(),
});
export type SpecPatch = z.infer<typeof specPatchSchema>;

export const plannerDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool_call"),
    toolId: z.string().min(1),
    args: z.record(z.unknown()).optional().default({}),
    reasoning: z.string().optional(),
    finishOnSuccess: z.boolean().optional(),
    completionSummary: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("finish"),
    summary: z.string().min(1),
  }),
]);
export type PlannerDecision = z.infer<typeof plannerDecisionSchema>;

export const toolArgGuideSchema = z.object({
  description: z.string().optional(),
  examples: z.array(z.string()).optional(),
  constraints: z.string().optional(),
});

export const toolOutputSummarySchema = z.object({
  fields: z.array(z.string()).default([]),
  notes: z.array(z.string()).optional(),
});

export const toolPlannerCardSchema = z.object({
  summary: z.string().min(1),
  whenToUse: z.string().optional(),
  whenNotToUse: z.string().optional(),
  argGuides: z.record(toolArgGuideSchema).default({}),
  outputSummary: toolOutputSummarySchema.optional(),
  antiPatterns: z.array(z.string()).optional(),
  relatedActionSlugs: z.array(z.string()).optional(),
});
export type ToolPlannerCard = z.infer<typeof toolPlannerCardSchema>;

export const connectorPlaybookSchema = z.object({
  composioSessionId: z.string().optional(),
  compiledAt: z.string().min(1),
  useCase: z.string().min(1),
  workflowSteps: z.array(z.string()).optional(),
  pitfalls: z.array(z.string()).optional(),
  toolkitVersions: z.record(z.string()).optional(),
});
export type ConnectorPlaybook = z.infer<typeof connectorPlaybookSchema>;

export const composioToolContractSchema = z.object({
  originalInputSchema: z.record(z.unknown()).default({}),
  originalOutputSchema: z.record(z.unknown()).optional(),
  modifiedInputSchema: z.record(z.unknown()).default({}),
  behaviorInstructions: z.array(z.string()).default([]),
  outputSufficiencyPaths: z.array(z.string()).default([]),
});
export type ComposioToolContract = z.infer<typeof composioToolContractSchema>;

export const resolvedToolSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  connector: z.string().min(1),
  actionSlug: z.string().min(1),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).optional(),
  originalInputSchema: z.record(z.unknown()).optional(),
  originalOutputSchema: z.record(z.unknown()).optional(),
  modifiedInputSchema: z.record(z.unknown()).optional(),
  behaviorInstructions: z.array(z.string()).default([]),
  outputSufficiencyPaths: z.array(z.string()).default([]),
  plannerCard: toolPlannerCardSchema,
  composioAction: composioActionInstructionSchema.optional(),
  sensitive: z.boolean().default(false),
  credentialRef: z.string().min(1).optional(),
  toolkitVersion: z.string().min(1).optional(),
  role: outcomeRoleSchema.optional(),
});
export type ResolvedTool = z.infer<typeof resolvedToolSchema>;

export const executionStepSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["tool", "transform"]),
  role: outcomeRoleSchema,
  toolId: z.string().min(1).optional(),
  description: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  inputRefs: z.array(z.string().min(1)).default([]),
  outputArtifact: z.string().min(1).optional(),
  requiresApproval: z.boolean().default(false),
});
export type ExecutionStep = z.infer<typeof executionStepSchema>;

export const executionStrategySchema = z.object({
  version: z.literal(1),
  mode: z.enum(["deterministic", "hybrid", "agentic"]),
  blueprint: taskBlueprintSchema.optional(),
  steps: z.array(executionStepSchema).default([]),
});
export type ExecutionStrategy = z.infer<typeof executionStrategySchema>;

export const compiledPlanSchema = z.object({
  id: z.string().uuid(),
  loopId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  specRevision: z.number().int(),
  revision: z.number().int(),
  contentHash: z.string().min(1),
  profile: executionProfileSchema,
  intent: intentSchema,
  trigger: triggerSchema,
  toolCatalog: z.array(resolvedToolSchema),
  composioActions: z.array(composioActionInstructionSchema).default([]),
  connectorPlaybook: connectorPlaybookSchema,
  agent: agentConfigSchema.optional(),
  monitor: monitorConfigSchema.optional(),
  sync: syncConfigSchema.optional(),
  output: outputConfigSchema,
  approval: approvalPolicySchema,
  guardrails: guardrailConfigSchema,
  executionStrategy: executionStrategySchema.optional(),
  compiledAt: z.string(),
  status: z.enum(["draft", "active", "superseded"]).default("draft"),
});
export type CompiledPlan = z.infer<typeof compiledPlanSchema>;

export function parseCompiledPlan(raw: unknown): CompiledPlan {
  return compiledPlanSchema.parse(raw);
}

export function createEmptyLoopSpec(workspaceId: string, partial?: Partial<LoopSpec>): LoopSpec {
  return loopSpecSchema.parse({
    workspaceId,
    intent: {
      goal: "Draft loop",
      outcome: "Draft outcome",
      successCriteria: [],
    },
    trigger: { kind: "manual" },
    profile: "agentic",
    bindings: [],
    composioActions: [],
    intentDiscovery: {
      status: "pending",
      decisions: [],
      assumptions: [],
    },
    agent: {
      instructions: "Achieve the stated outcome using only the bound tools.",
      maxSteps: 12,
      maxTokens: 8_000,
    },
    output: { kind: "none" },
    approval: {
      mode: "mixed",
      sensitiveRoles: [],
      sensitiveCapabilities: [],
      defaultTimeoutHours: 24,
      onTimeout: "reject",
    },
    guardrails: {
      allowedTools: [],
      deniedTools: [],
      maxRetriesPerStep: 3,
      maxRunDurationMinutes: 60,
    },
    ...partial,
  });
}
