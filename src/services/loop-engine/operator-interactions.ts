import { z } from "zod";

export const operatorInteractionPlanItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  prompt: z.string().optional(),
  stepId: z.string().optional(),
});

export const operatorInteractionPlanSchema = z.object({
  items: z.array(operatorInteractionPlanItemSchema).default([]),
});

export type OperatorInteractionPlanItem = z.infer<typeof operatorInteractionPlanItemSchema>;
