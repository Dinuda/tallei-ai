import type { UIMessage } from "ai";

import type { BuilderState } from "../contracts/builder-types.js";
import type { WorkflowBuilderSession } from "../services/session.service.js";
import type { BuilderActionName } from "./state-machine.js";

export type BuilderStatePolicy = {
  state: BuilderState;
  objective: string;
  instructions: string[];
  forbiddenTopics: string[];
  actionGuidance: Partial<Record<BuilderActionName, string>>;
};

const INTERNAL_AI_FORBIDDEN_TOPICS = [
  "AI providers",
  "model providers",
  "classification models",
  "LLM tools",
  "internal Tallei execution details",
];

const POLICIES: Record<BuilderState, BuilderStatePolicy> = {
  "intent.collecting": {
    state: "intent.collecting",
    objective: "Understand the user's desired business outcome and end result.",
    instructions: [
      "Clarify only outcome, business trigger or cadence, approval expectation, and final output.",
      "Resolve intent as soon as the outcome and end result are clear enough.",
      "Apps, ticket platforms, email tools, files, records, and data locations are setup details for a later state.",
      "Assumptions must be business-level only, such as cadence and approval expectations.",
    ],
    forbiddenTopics: [
      "app selection",
      "connector selection",
      "ticket platform selection",
      "email tool selection",
      "data-source location questions",
      ...INTERNAL_AI_FORBIDDEN_TOPICS,
    ],
    actionGuidance: {
      intentClarification: "Ask exactly one outcome-level clarification and stop.",
      resolveIntent: "Persist a concise intent: When X happens -> do A, B, C -> output Y.",
    },
  },
  "intent.resolving": {
    state: "intent.resolving",
    objective: "Persist the resolved business intent.",
    instructions: [
      "Write the resolved intent as trigger, actions, approval expectation, and output.",
      "Do not introduce app, connector, data-source, or provider choices.",
    ],
    forbiddenTopics: ["app selection", "connector selection", ...INTERNAL_AI_FORBIDDEN_TOPICS],
    actionGuidance: {
      resolveIntent: "Persist the resolved business intent and stop.",
    },
  },
  "requirements.selecting_apps": {
    state: "requirements.selecting_apps",
    objective: "Identify the external business systems Tallei must read from or write to.",
    instructions: [
      "Ask in a concrete order based on the resolved intent.",
      "For support workflows, ask where customers send support requests first.",
      "Mention reply or delivery channels only when they may be separate from the intake system.",
      "Recommend only external business systems, such as support inboxes, ticketing tools, email/chat delivery channels, CRM systems, or knowledge sources.",
    ],
    forbiddenTopics: [
      "broad catalogue questions",
      "which applications do you want to use",
      ...INTERNAL_AI_FORBIDDEN_TOPICS,
    ],
    actionGuidance: {
      appSelection: "Request explicit app selection and stop.",
      getAvailableTools: "Use only after selected app toolkits are present in the latest appSelection output.",
    },
  },
  "requirements.discovering_tools": {
    state: "requirements.discovering_tools",
    objective: "Discover connector actions for the selected apps.",
    instructions: [
      "Run discovery once for the selected toolkits.",
      "Use focused capability queries based on the resolved intent.",
    ],
    forbiddenTopics: INTERNAL_AI_FORBIDDEN_TOPICS,
    actionGuidance: {
      getAvailableTools: "Discover available connector actions and stop.",
    },
  },
  "requirements.resolving": {
    state: "requirements.resolving",
    objective: "Resolve exactly one remaining build requirement.",
    instructions: [
      "Resolve one requirement or ask one setup UI question, then stop.",
      "Prefer runtime inputs for values that vary per run.",
      "Use connectorSetup only to verify app connection status.",
      "Do not configure parent goals or connector sub-agents.",
    ],
    forbiddenTopics: INTERNAL_AI_FORBIDDEN_TOPICS,
    actionGuidance: {
      connectorSetup: "Verify the required connector connection and stop.",
      scheduleSetup: "Ask how the loop runs only when the pending requirement is trigger_schedule.",
      knowledgeBaseSetup: "Ask for reference material only when the pending requirement is grounding.",
      renderType: "Prepare artifact template options before artifactSetup.",
      artifactSetup: "Ask the user to confirm the generated artifact/reply template.",
      requirementSetup: "Ask one structured question for the pending generic requirement.",
      resolveBuildRequirement: "Resolve one pending requirement with a typed value.",
    },
  },
  "compile.previewing": {
    state: "compile.previewing",
    objective: "Preview the runtime agent plan before saving.",
    instructions: [
      "Preview the runtime plan before save.",
      "Summarize who the agents are, what each does, and what external channels they read or write.",
    ],
    forbiddenTopics: ["draft specification", "workflow specification", "draftSpec"],
    actionGuidance: {
      previewAgentPlan: "Compile and preview the runtime agent plan, then stop.",
    },
  },
  "compile.awaiting_approval": {
    state: "compile.awaiting_approval",
    objective: "Get explicit approval before saving the loop.",
    instructions: [
      "Never save without explicit user approval.",
      "If the user is not ready, keep the turn on approval and ask what is missing.",
    ],
    forbiddenTopics: ["draft specification", "workflow specification", "draftSpec"],
    actionGuidance: {
      saveApproval: "Ask whether to save and run a test now, or to hold and explain what is missing.",
      saveLoop: "Save only after explicit user approval.",
    },
  },
  "verification.testing": {
    state: "verification.testing",
    objective: "Run a safe verification test for the saved loop.",
    instructions: [
      "Test before activation.",
      "Report actual test results, not assumptions.",
    ],
    forbiddenTopics: [],
    actionGuidance: {
      runBuilderTest: "Run the saved-loop test and stop.",
      runVerification: "Run workflow verification checks and stop.",
    },
  },
  "verification.awaiting_activation": {
    state: "verification.awaiting_activation",
    objective: "Get explicit approval before activation.",
    instructions: [
      "Never activate without explicit user approval.",
      "If the user is not ready, keep the turn on activation approval and ask what remains unclear.",
    ],
    forbiddenTopics: [],
    actionGuidance: {
      activationApproval: "Ask whether to activate now, or to hold and explain what still needs review.",
      confirmActivation: "Activate only after explicit user approval.",
    },
  },
  complete: {
    state: "complete",
    objective: "Report that the builder flow is complete.",
    instructions: ["Keep the status update concise."],
    forbiddenTopics: [],
    actionGuidance: {},
  },
  failed: {
    state: "failed",
    objective: "Explain the blocker and request corrective input.",
    instructions: ["Keep the issue operator-readable and avoid internal stack details."],
    forbiddenTopics: [],
    actionGuidance: {
      repairPrompt: "Ask for the missing correction needed to continue.",
    },
  },
};

function latestUserText(messages: UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (text) return text;
  }
  return null;
}

export function getBuilderStatePolicy(state: BuilderState): BuilderStatePolicy {
  return POLICIES[state];
}

export function compactBuilderContext(input: {
  session: WorkflowBuilderSession;
  state: BuilderState;
  allowedActions: BuilderActionName[];
  messages: UIMessage[];
}): Record<string, unknown> {
  const unresolvedRequirements = input.session.buildContract?.requirements
    .filter((entry) => entry.status !== "resolved")
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      question: entry.question,
      required: entry.required,
    })) ?? [];

  const resolvedRequirements = input.session.buildContract?.requirements
    .filter((entry) => entry.status === "resolved")
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      value: entry.value,
    })) ?? [];

  return {
    sessionId: input.session.id,
    sessionRevision: input.session.revision,
    state: input.state,
    allowedActions: input.allowedActions,
    goal: input.session.goal,
    latestUserMessage: latestUserText(input.messages),
    resolvedIntent: input.session.resolvedIntent?.resolvedIntent ?? null,
    selectedToolContractCount: input.session.discoveredToolContracts.length,
    unresolvedRequirements,
    resolvedRequirements,
    workflowId: input.session.workflowId,
  };
}

export function buildBuilderSystemPrompt(input: {
  state: BuilderState;
  allowedActions: BuilderActionName[];
  session: WorkflowBuilderSession;
  messages: UIMessage[];
}): string {
  const policy = getBuilderStatePolicy(input.state);
  const actionGuidance = input.allowedActions
    .map((action) => `- ${action}: ${policy.actionGuidance[action] ?? "Allowed in this state."}`)
    .join("\n");

  return [
    "You are Tallei Builder.",
    "You are one stable builder runtime, not a rotating specialist persona.",
    "The backend owns routing, identity, and state transitions.",
    "Choose at most one allowed action for this turn.",
    "If user input is needed, call exactly one client action and stop.",
    "If backend work is needed, call exactly one server action and stop after the result.",
    "Never call tools that are not listed in allowedActions.",
    "If no action is needed, answer normally in concise plain text.",
    "Do not expose internal state names, schema errors, or tool ids.",
    `Objective: ${policy.objective}`,
    `Instructions:\n${policy.instructions.map((entry) => `- ${entry}`).join("\n")}`,
    policy.forbiddenTopics.length > 0
      ? `Forbidden topics:\n${policy.forbiddenTopics.map((entry) => `- ${entry}`).join("\n")}`
      : "Forbidden topics: none beyond normal safety and privacy constraints.",
    `Allowed action guidance:\n${actionGuidance || "- No actions are allowed."}`,
    `Compact builder context:\n${JSON.stringify(compactBuilderContext(input))}`,
  ].join("\n\n");
}
