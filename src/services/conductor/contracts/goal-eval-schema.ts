import { z } from "zod";

const loopGateTypeSchema = z.enum(["input", "approval"]);

const goalEvalStatusSchema = z.enum(["pass", "fail", "needs_input", "retry"]);

export const goalEvalResultSchema = z.object({
  status: goalEvalStatusSchema,
  reason: z.string().min(1),
  blockers: z.array(z.string()).default([]),
  gateType: loopGateTypeSchema.optional(),
  missingRequired: z.array(z.string()).optional(),
  normalizedOutput: z.record(z.unknown()).optional(),
  normalizedHandoff: z.record(z.unknown()).optional(),
});

export type GoalEvalResult = z.infer<typeof goalEvalResultSchema>;
