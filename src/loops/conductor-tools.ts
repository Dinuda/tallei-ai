import { z } from "zod";

import { intentAnalysisSchema } from "./intent-discovery.js";
import { specPatchSchema } from "./spec.js";

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
  outcomeId: z.string().min(1).optional(),
  role: z.enum(["trigger", "source", "transform", "destination"]).optional(),
});

export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;
export type AskQuestionOutput = z.infer<typeof askQuestionOutputSchema>;

/** Server-driven connector picker — options come from discoverConnectorsForBlueprint, not the model. */
export const pickConnectorAppInputSchema = z.object({
  outcomeId: z.string().min(1),
  role: z.enum(["trigger", "source", "destination"]),
  question: z.string().min(1).optional(),
});

export type PickConnectorAppInput = z.infer<typeof pickConnectorAppInputSchema>;

export const analyzeIntentInputSchema = intentAnalysisSchema;
export type AnalyzeIntentInput = z.infer<typeof analyzeIntentInputSchema>;

export const listTriggersInputSchema = z.object({
  toolkit: z.string().min(1),
});

export const listActionsInputSchema = z.object({
  toolkit: z.string().min(1),
});

export const connectToolkitInputSchema = z.object({
  toolkit: z.string().min(1),
  callbackUrl: z.string().url().optional(),
});

export const listWorkspaceConnectorsInputSchema = z.object({});

export const reviewOutcomeBriefInputSchema = z.object({});

const outcomeBriefUserSummarySchema = z.object({
  whenItRuns: z.string().min(1),
  appsInvolved: z.array(z.string().min(1)),
  steps: z.array(z.string().min(1)).min(1),
  beforeSending: z.string().min(1),
  howYouKnowItWorked: z.string().min(1),
  whereResultsGo: z.string().min(1),
  safetyLimits: z.array(z.string().min(1)),
  assumptionsNote: z.string().optional(),
});

const outcomeBriefSchema = z.object({
  outcome: z.string().min(1),
  successCriteria: z.array(z.string()),
  trigger: z.string().min(1),
  actions: z.array(z.string()),
  connectors: z.array(z.object({
    outcomeId: z.string().min(1),
    role: z.string().min(1),
    description: z.string().min(1),
    connector: z.string().min(1),
  })),
  output: z.string(),
  approvals: z.string(),
  guardrails: z.array(z.string()),
  assumptions: z.array(z.string()),
  userSummary: outcomeBriefUserSummarySchema.optional(),
});

export const outcomeBriefOutputSchema = z.object({
  brief: outcomeBriefSchema,
  briefHash: z.string().min(1),
});

export const confirmOutcomeBriefActionSchema = z.enum([
  "confirm",
  "change_outcome",
  "change_trigger",
  "change_connectors",
  "change_approvals",
  "other",
]);

export const confirmOutcomeBriefInputSchema = z.object({
  briefHash: z.string().min(1),
  question: z.string().min(1),
  options: z.array(askQuestionOptionSchema).min(2).max(5),
  recommendedOptionIds: z.array(z.string()).optional(),
  allowOther: z.boolean().optional(),
});

export const confirmOutcomeBriefOutputSchema = z.object({
  action: confirmOutcomeBriefActionSchema,
  briefHash: z.string().min(1),
  answerText: z.string().min(1),
  selectedOptionIds: z.array(z.string()),
  selectedValues: z.array(z.string()),
  otherText: z.string().optional(),
});

export function resolveConfirmOutcomeBriefAction(
  selectedValue: string,
): z.infer<typeof confirmOutcomeBriefActionSchema> {
  const parsed = confirmOutcomeBriefActionSchema.safeParse(selectedValue);
  return parsed.success ? parsed.data : "other";
}

export type ConfirmOutcomeBriefInput = z.infer<typeof confirmOutcomeBriefInputSchema>;
export type ConfirmOutcomeBriefOutput = z.infer<typeof confirmOutcomeBriefOutputSchema>;

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
    role: z.enum(["trigger", "source", "transform", "destination"]).optional(),
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

export const CONDUCTOR_TOOL_INPUT_EXAMPLES = {
  analyzeIntent: analyzeIntentInputSchema.parse({
    outcome: "Send personalized replies to new support emails.",
    trigger: "When a new support email arrives.",
    approval: {
      mode: "mixed",
      sensitiveRoles: ["destination"],
      sensitiveCapabilities: [],
    },
    decisions: [
      {
        questionId: "channel",
        question: "Where do support emails arrive?",
        answer: "Gmail",
      },
      {
        questionId: "approval-mode",
        question: "Should replies send automatically or wait for your review?",
        answer: "Review first",
      },
    ],
  }),
  askQuestion: askQuestionInputSchema.parse({
    questionId: "approval-mode",
    question: "Should replies send automatically or wait for your review?",
    options: [
      { id: "review", label: "Review first", value: "review_first" },
      { id: "auto", label: "Send automatically", value: "auto" },
    ],
    recommendedOptionIds: ["review"],
    allowMultiple: false,
    allowOther: true,
    step: { index: 1, total: 1 },
  }),
  patchLoopSpec: {
    initialBlueprint: specPatchSchema.parse({
      taskBlueprint: {
        version: 1,
        summary: "Handle new support emails and send replies.",
        outcomes: [
          {
            id: "new-email",
            role: "trigger",
            description: "Detect when a new support email arrives.",
            status: "pending",
          },
          {
            id: "send-reply",
            role: "destination",
            description: "Send a personalized reply to the customer.",
            status: "pending",
          },
        ],
      },
      agent: {
        instructions: "Review support emails and prepare helpful customer replies.",
      },
      approval: {
        mode: "mixed",
        sensitiveRoles: ["destination"],
        sensitiveCapabilities: [],
      },
    }),
    connectorChoice: specPatchSchema.parse({
      taskBlueprint: {
        version: 1,
        summary: "Handle new support emails and send replies.",
        outcomes: [
          {
            id: "send-reply",
            role: "destination",
            description: "Send a personalized reply to the customer.",
            selectedConnector: "gmail",
            status: "chosen",
          },
        ],
      },
    }),
    triggerAndBindings: specPatchSchema.parse({
      trigger: {
        kind: "event",
        source: "gmail",
        composioSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      },
      bindings: [
        {
          capability: "read incoming support email",
          connector: "gmail",
          actionSlug: "GMAIL_FETCH_EMAILS",
          role: "source",
        },
      ],
      output: {
        kind: "chat",
      },
    }),
    confirmation: specPatchSchema.parse({
      intentDiscovery: {
        status: "confirmed",
        confirmedBriefHash: "brief-hash-123",
      },
    }),
  },
  discoverConnectorsForBlueprint: discoverConnectorsForBlueprintInputSchema.parse({
    outcomes: [
      {
        id: "new-email",
        role: "trigger",
        description: "Detect when a new support email arrives.",
      },
      {
        id: "send-reply",
        role: "destination",
        description: "Send a personalized reply to the customer.",
      },
    ],
  }),
  pickConnectorApp: pickConnectorAppInputSchema.parse({
    outcomeId: "send-reply",
    role: "destination",
    question: "Where should the customer replies be sent from?",
  }),
  presentReplyOptions: presentReplyOptionsInputSchema.parse({
    options: [
      { id: "prepare", label: "Prepare it", message: "Yes, prepare this loop." },
      { id: "change", label: "Make changes", message: "I want to change it first." },
    ],
  }),
  listTriggers: listTriggersInputSchema.parse({
    toolkit: "gmail",
  }),
  listActions: listActionsInputSchema.parse({
    toolkit: "gmail",
  }),
  discoverBindings: discoverBindingsInputSchema.parse({
    toolkit: "gmail",
    outcomes: [
      {
        id: "send-reply",
        description: "Send a personalized reply to the customer.",
        role: "destination",
      },
    ],
  }),
  connectToolkit: connectToolkitInputSchema.parse({
    toolkit: "gmail",
    callbackUrl: "https://example.com/api/connectors/callback",
  }),
  listWorkspaceConnectors: listWorkspaceConnectorsInputSchema.parse({}),
  reviewOutcomeBrief: reviewOutcomeBriefInputSchema.parse({}),
  confirmOutcomeBrief: confirmOutcomeBriefInputSchema.parse({
    briefHash: "brief-hash-123",
    question: "Does this look right before I prepare the loop?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "change", label: "Change it", value: "other" },
    ],
    recommendedOptionIds: ["confirm"],
    allowOther: true,
  }),
  compileLoop: compileLoopInputSchema.parse({}),
  testRunLoop: testRunLoopInputSchema.parse({
    compiledPlanId: "11111111-1111-4111-8111-111111111111",
    scenario: {
      label: "New customer support email",
      triggerPayload: {
        from: "customer@example.com",
        subject: "Need help with my order",
      },
      context: "Use a friendly, concise tone.",
    },
  }),
  activateLoop: activateLoopInputSchema.parse({
    compiledPlanId: "11111111-1111-4111-8111-111111111111",
  }),
} as const;
