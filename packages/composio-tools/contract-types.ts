import { z } from "zod";

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

export const composioToolContractSchema = z.object({
  originalInputSchema: z.record(z.unknown()).default({}),
  originalOutputSchema: z.record(z.unknown()).optional(),
  modifiedInputSchema: z.record(z.unknown()).default({}),
  behaviorInstructions: z.array(z.string()).default([]),
  outputSufficiencyPaths: z.array(z.string()).default([]),
});
export type ComposioToolContract = z.infer<typeof composioToolContractSchema>;

/** Structural tool shape used by contract / arg-resolution helpers. */
export type ResolvedToolLike = {
  id: string;
  connector: string;
  actionSlug: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  originalInputSchema?: Record<string, unknown>;
  originalOutputSchema?: Record<string, unknown>;
  modifiedInputSchema?: Record<string, unknown>;
  behaviorInstructions?: string[];
  outputSufficiencyPaths?: string[];
  composioAction?: ComposioActionInstruction;
  capability?: string;
  [key: string]: unknown;
};

/** Minimal plan surface needed to resolve Composio action args. */
export type ComposioArgResolutionPlan = {
  toolCatalog: Array<{ id: string; actionSlug: string; [key: string]: unknown }>;
  composioActions: ComposioActionInstruction[];
  trigger: { kind: string; composioSlug?: string; [key: string]: unknown };
  [key: string]: unknown;
};
