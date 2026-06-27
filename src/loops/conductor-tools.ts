import { z } from "zod";

export const askQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  outcomeId: z.string().optional(),
  role: z.string().optional(),
});

export const askQuestionInputSchema = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(askQuestionOptionSchema).min(2),
  recommendedOptionIds: z.array(z.string()).optional(),
  allowMultiple: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  step: z.object({
    index: z.number().int().min(1),
    total: z.number().int().min(1),
  }).optional(),
});

export const askQuestionOutputSchema = z.object({
  questionId: z.string().min(1),
  answerText: z.string().min(1),
  selectedOptionIds: z.array(z.string()),
  selectedValues: z.array(z.string()),
  otherText: z.string().optional(),
  skipped: z.boolean().optional(),
});

export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;
export type AskQuestionOutput = z.infer<typeof askQuestionOutputSchema>;

/** Server-driven connector picker — options come from discoverConnectorsForBlueprint, not the model. */
export const pickConnectorAppInputSchema = z.object({
  question: z.string().min(1).optional(),
});

export type PickConnectorAppInput = z.infer<typeof pickConnectorAppInputSchema>;

/** Clickable quick-reply chips for conversational yes/no or next-step choices. */
export const presentReplyOptionsInputSchema = z.object({
  options: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    message: z.string().min(1),
  })).min(2).max(5),
});

export const presentReplyOptionsOutputSchema = z.object({
  selectedOptionId: z.string().min(1),
  message: z.string().min(1),
});

export type PresentReplyOptionsInput = z.infer<typeof presentReplyOptionsInputSchema>;
export type PresentReplyOptionsOutput = z.infer<typeof presentReplyOptionsOutputSchema>;

export const discoverBindingsInputSchema = z.object({
  toolkit: z.string().min(1),
  outcomes: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
  })).min(1),
});

export type DiscoverBindingsInput = z.infer<typeof discoverBindingsInputSchema>;

export const discoverConnectorsForBlueprintInputSchema = z.object({
  outcomes: z.array(z.object({
    id: z.string().min(1),
    role: z.enum(["trigger", "source", "transform", "destination"]),
    description: z.string().min(1),
  })).min(1),
});

export type DiscoverConnectorsForBlueprintInput = z.infer<typeof discoverConnectorsForBlueprintInputSchema>;

export const compileLoopInputSchema = z.object({});

export const activateLoopInputSchema = z.object({
  compiledPlanId: z.string().uuid().optional(),
});

export type CompileLoopInput = z.infer<typeof compileLoopInputSchema>;
export type ActivateLoopInput = z.infer<typeof activateLoopInputSchema>;

export const testRunScenarioSchema = z.object({
  label: z.string().min(1),
  triggerPayload: z.record(z.unknown()).optional(),
  context: z.string().optional(),
});

export const testRunLoopInputSchema = z.object({
  compiledPlanId: z.string().uuid().optional(),
  scenario: testRunScenarioSchema,
});

export type TestRunScenario = z.infer<typeof testRunScenarioSchema>;
export type TestRunLoopInput = z.infer<typeof testRunLoopInputSchema>;
