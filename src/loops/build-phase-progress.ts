import type { UIMessage } from "ai";

import { isActivationConfirmationReply } from "../../shared/conductor-activation-confirm.js";
import { derivePendingUiToolFromEvents, type LoopBuildEvent, type PendingUiToolCall } from "./build-events.js";
import {
  bindingEvidenceFromMessages,
  completedToolEvents,
  connectorSelectionEvidence,
  deriveBindingArtifactResult,
  deriveReviewProgress,
  interpretBindingDiscovery,
} from "./build-event-interpreter.js";
import {
  blueprintArtifactSchema,
  type BuildPhase,
  type LoopBuildState,
  testArtifactSchema,
} from "./build-state.js";
import type { IntentAnalysis } from "./intent-discovery.js";
import { conductorStepLimitForPhase } from "./conductor-turn-budget.js";

export type BuildEvidenceSource = UIMessage[] | LoopBuildEvent[];

export type ConductorToolName =
  | "analyzeIntent"
  | "askQuestion"
  | "discoverConnectorsForBlueprint"
  | "pickConnectorApp"
  | "listWorkspaceConnectors"
  | "connectToolkit"
  | "listTriggers"
  | "listActions"
  | "discoverBindings"
  | "resolveBindings"
  | "presentAgentTeam"
  | "confirmOutcomeBrief"
  | "compileLoop"
  | "testRunLoop"
  | "presentReplyOptions"
  | "activateLoop";

export type BuildPhaseProgressStatus = "pending" | "in_progress" | "complete" | "waiting";

export type BuildPhaseProgress = {
  phase: BuildPhase;
  status: BuildPhaseProgressStatus;
  goal: string;
  completionCriteria: string[];
  nextTool: ConductorToolName | null;
  allowedTools: ConductorToolName[];
  maxSteps: number;
  autoAdvance: boolean;
  instruction: string;
  handoffPending: boolean;
  terminal: boolean;
  reason?: string;
  pendingUiTool?: PendingUiToolCall | null;
};

export type BuildPhaseProgressContext = {
  effectivePhase?: BuildPhase;
  resumeTool?: string | null;
  connectedToolkits?: Array<{ slug: string; connected: boolean }>;
  loopStatus?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function progress(
  phase: BuildPhase,
  input: Partial<BuildPhaseProgress> & Pick<BuildPhaseProgress, "instruction">,
): BuildPhaseProgress {
  const defaults = {
    intent: {
      goal: "Capture the workflow outcome and any missing business choices.",
      completionCriteria: [
        "Intent analysis is recorded.",
        "Every required business question has an answer.",
        "The blueprint can be derived from persisted intent data.",
      ],
      autoAdvance: true,
    },
    blueprint: {
      goal: "Derive the executable blueprint from the confirmed intent.",
      completionCriteria: [
        "The blueprint artifact is committed from persisted intent data.",
      ],
      autoAdvance: true,
    },
    connectors: {
      goal: "Choose connected apps for each non-transform blueprint outcome.",
      completionCriteria: [
        "Each trigger, source, and destination outcome has a connector selection.",
        "The connector artifact is committed for the current blueprint revision.",
      ],
      autoAdvance: true,
    },
    bindings: {
      goal: "Resolve concrete triggers and actions for the selected apps.",
      completionCriteria: [
        "Trigger discovery is available for the selected trigger app.",
        "Action discovery is available for every selected source or destination app.",
        "The bindings artifact is committed for the current connector revision.",
      ],
      autoAdvance: true,
    },
    review: {
      goal: "Present the specialist roster and capture the review decision.",
      completionCriteria: [
        "The specialist team review has been presented.",
        "The review confirmation has been persisted for the current bindings revision.",
      ],
      autoAdvance: true,
    },
    compile: {
      goal: "Compile the confirmed automation into a runnable plan.",
      completionCriteria: [
        "A compiled plan artifact exists for the current review revision.",
      ],
      autoAdvance: true,
    },
    test: {
      goal: "Record a passing test for the current compiled plan.",
      completionCriteria: [
        "A passing test run is persisted for the current compiled plan.",
      ],
      autoAdvance: true,
    },
    activation: {
      goal: "Collect explicit activation approval and activate the loop.",
      completionCriteria: [
        "The activation confirmation has been answered.",
        "The loop is activated for the tested compiled plan.",
      ],
      autoAdvance: false,
    },
  } as const satisfies Record<BuildPhase, {
    goal: string;
    completionCriteria: string[];
    autoAdvance: boolean;
  }>;
  const contract = defaults[phase];
  return {
    phase,
    status: input.status ?? "in_progress",
    goal: input.goal ?? contract.goal,
    completionCriteria: input.completionCriteria ?? [...contract.completionCriteria],
    nextTool: input.nextTool ?? null,
    allowedTools: input.allowedTools ?? (input.nextTool ? [input.nextTool] : []),
    maxSteps: input.maxSteps ?? conductorStepLimitForPhase(phase),
    autoAdvance: input.autoAdvance ?? contract.autoAdvance,
    instruction: input.instruction,
    handoffPending: input.handoffPending ?? false,
    terminal: input.terminal ?? false,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function intentQuestionsFromAnalysis(messages: BuildEvidenceSource): IntentAnalysis["questions"] {
  const analysisEvent = completedToolEvents(messages, "analyzeIntent").at(-1);
  if (!analysisEvent) return [];
  const rawAnalysis = isRecord(analysisEvent.output) && isRecord(analysisEvent.output.analysis)
    ? analysisEvent.output.analysis
    : analysisEvent.input;
  if (!isRecord(rawAnalysis) || !Array.isArray(rawAnalysis.questions)) return [];
  return rawAnalysis.questions as IntentAnalysis["questions"];
}

function answeredQuestionIds(messages: BuildEvidenceSource): Set<string> {
  const answered = new Set<string>();
  for (const event of completedToolEvents(messages, "askQuestion")) {
    if (!isRecord(event.output)) continue;
    const questionId = String(event.output.questionId ?? "").trim();
    const answer = String(event.output.answerText ?? "").trim();
    if (questionId && answer && answer !== "skipped") answered.add(questionId);
  }
  return answered;
}

function isLoopBuildEventSource(messages: BuildEvidenceSource): messages is LoopBuildEvent[] {
  const first = messages[0];
  return Boolean(first && "eventKey" in first);
}

function hasUnansweredUiTool(messages: BuildEvidenceSource, toolName: ConductorToolName): boolean {
  if (isLoopBuildEventSource(messages)) {
    const pending = derivePendingUiToolFromEvents(messages);
    return pending?.toolName === toolName;
  }
  for (const message of messages as UIMessage[]) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      const candidate = part as { type: string; toolName?: string; state?: string; output?: unknown };
      const resolved = candidate.type === "dynamic-tool" && candidate.toolName
        ? candidate.toolName
        : candidate.type.replace(/^tool-/, "");
      if (resolved !== toolName) continue;
      if (candidate.state === "input-available" && candidate.output == null) return true;
    }
  }
  return false;
}

function lastResolveBindingsOutput(messages: BuildEvidenceSource): Record<string, unknown> | null {
  const event = completedToolEvents(messages, "resolveBindings").at(-1);
  if (!event || !isRecord(event.output)) return null;
  return event.output;
}

function bindingQuestionAnswered(messages: BuildEvidenceSource, questionId: string): boolean {
  return answeredQuestionIds(messages).has(questionId);
}

function requiredConnectorOutcomeIds(state: LoopBuildState): string[] {
  if (!state.artifacts.blueprint) return [];
  const blueprint = blueprintArtifactSchema.parse(state.artifacts.blueprint.artifact);
  return blueprint.taskBlueprint.outcomes
    .filter((outcome) => outcome.role !== "transform")
    .map((outcome) => outcome.id);
}

function pendingConnectorOutcomeIds(state: LoopBuildState, messages: BuildEvidenceSource): string[] {
  const required = requiredConnectorOutcomeIds(state);
  const selected = new Set(connectorSelectionEvidence(messages).map((row) => row.outcomeId));
  return required.filter((outcomeId) => !selected.has(outcomeId));
}

function connectorToolkits(state: LoopBuildState): string[] {
  if (!state.artifacts.connectors) return [];
  const artifact = state.artifacts.connectors.artifact as { selections?: Array<{ connector: string }> };
  return [...new Set((artifact.selections ?? []).map((row) => row.connector.toLowerCase()))];
}

function discoveredConnectorToolkits(messages: BuildEvidenceSource): Set<string> {
  const discovered = new Set<string>();
  for (const event of completedToolEvents(messages, "discoverBindings")) {
    if (!isRecord(event.output)) continue;
    const toolkit = String(event.output.toolkit ?? "").trim().toLowerCase();
    if (toolkit) discovered.add(toolkit);
  }
  return discovered;
}

function listedTriggerToolkits(messages: BuildEvidenceSource): Set<string> {
  const listed = new Set<string>();
  for (const event of completedToolEvents(messages, "listTriggers")) {
    if (!isRecord(event.output)) continue;
    const toolkit = String(event.output.toolkit ?? "").trim().toLowerCase();
    if (toolkit) listed.add(toolkit);
  }
  return listed;
}

function successfulToolOutput(messages: BuildEvidenceSource, tool: ConductorToolName): boolean {
  const event = completedToolEvents(messages, tool).at(-1);
  if (!event || !isRecord(event.output)) return false;
  return event.output.ok !== false;
}

export function deriveIntentProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
): BuildPhaseProgress {
  const phase = "intent";
  if (state.buildPhase !== phase) {
    return progress(phase, {
      status: "complete",
      instruction: "Intent is already committed.",
      terminal: true,
      allowedTools: [],
    });
  }
  const analysisEvent = completedToolEvents(messages, "analyzeIntent").at(-1);
  if (!analysisEvent) {
    return progress(phase, {
      status: "pending",
      nextTool: "analyzeIntent",
      instruction: "Call analyzeIntent once, then ask every returned business question in the same assistant turn.",
    });
  }
  const questions = intentQuestionsFromAnalysis(messages);
  const answered = answeredQuestionIds(messages);
  const nextQuestion = questions.find((question) => !answered.has(question.id));
  if (nextQuestion) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "askQuestion",
      instruction: `Ask the remaining intent question (${nextQuestion.id}) with askQuestion. Preserve the analyzer wording exactly.`,
      handoffPending: hasUnansweredUiTool(messages, "askQuestion") === false
        && questions.length > 0
        && Boolean(analysisEvent),
      reason: "intent_question_pending",
    });
  }
  return progress(phase, {
    status: "waiting",
    instruction: "Intent questions are complete; the server will derive the blueprint automatically.",
    terminal: true,
    allowedTools: [],
  });
}

export function deriveBlueprintProgress(): BuildPhaseProgress {
  return progress("blueprint", {
    status: "waiting",
    instruction: "Wait for the server-derived blueprint; do not call another tool.",
    terminal: true,
    allowedTools: [],
  });
}

export function deriveConnectorProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
  context: BuildPhaseProgressContext = {},
): BuildPhaseProgress {
  const phase = "connectors";
  if (state.buildPhase !== phase && context.effectivePhase !== phase) {
    return progress(phase, {
      status: "complete",
      instruction: "Connector selections are already committed.",
      terminal: true,
      allowedTools: [],
    });
  }
  const discoveryEvent = completedToolEvents(messages, "discoverConnectorsForBlueprint").at(-1);
  if (!discoveryEvent) {
    return progress(phase, {
      status: "pending",
      nextTool: "discoverConnectorsForBlueprint",
      instruction: "Call discoverConnectorsForBlueprint to load the connector catalogue for each unresolved app role.",
    });
  }
  const pendingOutcomes = pendingConnectorOutcomeIds(state, messages);
  if (pendingOutcomes.length > 0) {
    const disconnected = (context.connectedToolkits ?? [])
      .filter((toolkit) => !toolkit.connected)
      .map((toolkit) => toolkit.slug);
    if (disconnected.length > 0) {
      return progress(phase, {
        status: "in_progress",
        nextTool: "connectToolkit",
        allowedTools: ["pickConnectorApp", "connectToolkit", "listWorkspaceConnectors"],
        instruction: "A selected app still needs workspace authorization. Call connectToolkit or listWorkspaceConnectors, then pickConnectorApp for remaining roles.",
        reason: "connector_auth_pending",
      });
    }
    return progress(phase, {
      status: "in_progress",
      nextTool: "pickConnectorApp",
      instruction: "Call pickConnectorApp for each remaining unresolved app role. Do not summarize app choices in plain text.",
      handoffPending: successfulToolOutput(messages, "discoverConnectorsForBlueprint"),
      reason: "connector_pick_pending",
    });
  }
  return progress(phase, {
    status: "waiting",
    instruction: "Connector choices are complete; the server will commit them automatically.",
    terminal: true,
    allowedTools: [],
  });
}

export function deriveBindingProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
): BuildPhaseProgress {
  const phase = "bindings";
  if (!["bindings", "review", "compile"].includes(state.buildPhase) && state.buildPhase !== phase) {
    return progress(phase, {
      status: "complete",
      instruction: "Bindings are already committed.",
      terminal: true,
      allowedTools: [],
    });
  }
  if (interpretBindingDiscovery(state, messages)) {
    return progress(phase, {
      status: "complete",
      instruction: "Bindings are resolved for the current revision.",
      terminal: true,
      allowedTools: [],
    });
  }
  const resolveOutput = lastResolveBindingsOutput(messages);
  const pendingQuestions = Array.isArray(resolveOutput?.pendingQuestions)
    ? resolveOutput!.pendingQuestions.filter(isRecord)
    : [];
  const unanswered = pendingQuestions.find((question) => {
    const questionId = String(question.questionId ?? "").trim();
    return questionId && !bindingQuestionAnswered(messages, questionId);
  });
  if (unanswered) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "askQuestion",
      instruction: "Reproduce the pending binding question from resolveBindings exactly with askQuestion, then call resolveBindings again.",
      handoffPending: Boolean(resolveOutput),
      reason: "binding_question_pending",
    });
  }
  if (resolveOutput?.missingDiscovery === true) {
    const requiredToolkits = Array.isArray(resolveOutput.requiredToolkits)
      ? resolveOutput.requiredToolkits.map((toolkit) => String(toolkit).toLowerCase())
      : connectorToolkits(state);
    const missing = requiredToolkits.filter((toolkit) => !discoveredConnectorToolkits(messages).has(toolkit));
    return progress(phase, {
      status: "in_progress",
      nextTool: missing.length > 0 ? "discoverBindings" : "listTriggers",
      allowedTools: ["discoverBindings", "listTriggers", "listActions"],
      instruction: "Run discovery for the missing connector metadata, then call resolveBindings again.",
      reason: "binding_discovery_missing",
    });
  }
  const toolkits = connectorToolkits(state);
  const missingTriggers = toolkits.filter((toolkit) => !listedTriggerToolkits(messages).has(toolkit));
  if (missingTriggers.length > 0) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "listTriggers",
      allowedTools: ["listTriggers", "discoverBindings", "resolveBindings"],
      instruction: "Call listTriggers for each selected app, then discoverBindings and resolveBindings.",
      reason: "binding_triggers_missing",
    });
  }
  const missingDiscovery = toolkits.filter((toolkit) => !discoveredConnectorToolkits(messages).has(toolkit));
  if (missingDiscovery.length > 0) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "discoverBindings",
      allowedTools: ["discoverBindings", "listTriggers", "resolveBindings"],
      instruction: "Call discoverBindings for each selected app, then resolveBindings.",
      reason: "binding_actions_missing",
    });
  }
  const evidence = bindingEvidenceFromMessages(messages);
  const derivation = deriveBindingArtifactResult(state, evidence.discoveries, evidence.triggerLists, evidence.bindingConfigs);
  if (derivation.diagnostics.length > 0) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "resolveBindings",
      allowedTools: ["resolveBindings", "discoverBindings", "listTriggers", "askQuestion"],
      instruction: "Call resolveBindings to surface the next binding question or finalize bindings. Do not invent provider field names.",
      reason: "binding_diagnostics_pending",
    });
  }
  return progress(phase, {
    status: "in_progress",
    nextTool: "resolveBindings",
    instruction: "Call resolveBindings to finalize trigger and action bindings for the current revision.",
  });
}

export function deriveReviewPhaseProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
  context: BuildPhaseProgressContext = {},
): BuildPhaseProgress {
  const phase = "review";
  const review = deriveReviewProgress(state, messages, {
    effectivePhase: context.effectivePhase ?? phase,
  });
  if (!review) {
    return progress(phase, {
      status: "complete",
      instruction: "Review is already committed.",
      terminal: true,
      allowedTools: [],
    });
  }
  if (!review.nextTool) {
    return progress(phase, {
      status: "complete",
      instruction: "Review confirmation is complete.",
      terminal: true,
      allowedTools: [],
    });
  }
  const instruction = review.nextTool === "confirmOutcomeBrief"
    ? "The specialist team roster is already shown. Call confirmOutcomeBrief now in this step. Do not summarize or repeat the roster."
    : "Write one short introductory sentence, then call presentAgentTeam only. Do not summarize the team in text.";
  return progress(phase, {
    status: "in_progress",
    nextTool: review.nextTool,
    instruction,
    handoffPending: review.rosterPrepared && !review.confirmationComplete,
    reason: review.nextTool === "confirmOutcomeBrief" ? "review_confirm_pending" : "review_roster_pending",
  });
}

export function deriveCompileProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
  context: BuildPhaseProgressContext = {},
): BuildPhaseProgress {
  const phase = "compile";
  if (state.buildPhase !== phase && context.effectivePhase !== phase) {
    return progress(phase, {
      status: "complete",
      instruction: "Compile step is not active.",
      terminal: true,
      allowedTools: [],
    });
  }
  if (!state.artifacts.review) {
    return progress(phase, {
      status: "pending",
      nextTool: "compileLoop",
      allowedTools: ["compileLoop"],
      instruction: "Review must be confirmed before compileLoop can succeed.",
      reason: "review_prerequisite_missing",
      handoffPending: false,
    });
  }
  const resume = context.resumeTool === "compileLoop" ? "compileLoop" : "compileLoop";
  return progress(phase, {
    status: "in_progress",
    nextTool: resume,
    allowedTools: [
      "compileLoop",
      "listTriggers",
      "listActions",
      "discoverBindings",
      "askQuestion",
      "resolveBindings",
      "listWorkspaceConnectors",
      "connectToolkit",
    ],
    instruction: context.resumeTool === "compileLoop"
      ? "Call compileLoop now to build the runnable plan for the confirmed specification."
      : "Call compileLoop. If compile fails on technical metadata, rerun the relevant discovery tool before retrying.",
  });
}

export function isTestSatisfiedForCompile(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
): boolean {
  const compileHash = state.artifacts.compile?.artifactHash;
  if (!compileHash) return false;

  const testEnvelope = state.artifacts.test;
  if (testEnvelope) {
    const parsed = testArtifactSchema.safeParse(testEnvelope.artifact);
    if (parsed.success && parsed.data.compileHash === compileHash) {
      return true;
    }
  }

  return completedToolEvents(messages, "testRunLoop").some((event) => {
    if (!isRecord(event.output) || event.output.ok === false) return false;
    const metadata = event.output;
    return metadata.parentArtifactHash === compileHash || metadata.phaseCompleted === true;
  });
}

export function deriveTestProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
): BuildPhaseProgress {
  const phase = "test";
  if (state.buildPhase !== phase) {
    return progress(phase, {
      status: "complete",
      instruction: "Test step is not active.",
      terminal: true,
      allowedTools: [],
      reason: "test_phase_inactive",
    });
  }
  const compileHash = state.artifacts.compile?.artifactHash;
  if (!compileHash) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "testRunLoop",
      allowedTools: ["testRunLoop"],
      instruction: "A compiled plan artifact is required before testRunLoop can succeed.",
      reason: "compile_prerequisite_missing",
    });
  }
  if (isTestSatisfiedForCompile(state, messages)) {
    return progress(phase, {
      status: "complete",
      instruction: "Test run completed for the current compiled plan.",
      terminal: true,
      allowedTools: [],
    });
  }
  return progress(phase, {
    status: "in_progress",
    nextTool: "testRunLoop",
    instruction: "Call testRunLoop for the current compiled plan.",
  });
}

export function deriveActivationProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
  context: BuildPhaseProgressContext = {},
): BuildPhaseProgress {
  const phase = "activation";
  if (context.loopStatus === "active") {
    return progress(phase, {
      status: "complete",
      instruction: "Loop activation is complete.",
      terminal: true,
      allowedTools: [],
      reason: "activation_complete",
    });
  }
  if (state.buildPhase !== phase) {
    return progress(phase, {
      status: "complete",
      instruction: "Activation is not active.",
      terminal: true,
      allowedTools: [],
      reason: "activation_phase_inactive",
    });
  }
  if (!state.artifacts.test) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "testRunLoop",
      allowedTools: ["testRunLoop", "presentReplyOptions"],
      instruction: "A passing test artifact is required before activation.",
      reason: "test_prerequisite_missing",
    });
  }
  const activationSucceeded = state.artifacts.activation
    || completedToolEvents(messages, "activateLoop").some((event) => {
      if (!isRecord(event.output) || event.output.ok === false) return false;
      return event.output.turnOutcome === "build_complete"
        || event.output.ok === true
        || event.output.alreadyActive === true;
    });
  if (activationSucceeded) {
    return progress(phase, {
      status: "complete",
      instruction: "Loop activation is complete.",
      terminal: true,
      allowedTools: [],
      reason: "activation_complete",
    });
  }
  const activationConfirmed = completedToolEvents(messages, "presentReplyOptions").some((event) =>
    isActivationConfirmationReply(event.output, event.input));
  if (activationConfirmed) {
    return progress(phase, {
      status: "in_progress",
      nextTool: "activateLoop",
      allowedTools: ["activateLoop"],
      instruction: "Call activateLoop now that the user confirmed activation.",
    });
  }
  const replyEvents = completedToolEvents(messages, "presentReplyOptions");
  const promptUnanswered = hasUnansweredUiTool(messages, "presentReplyOptions");
  if (replyEvents.length > 0 || promptUnanswered) {
    if (!promptUnanswered && replyEvents.length > 0) {
      return progress(phase, {
        status: "in_progress",
        nextTool: "presentReplyOptions",
        allowedTools: ["presentReplyOptions"],
        instruction: "The user declined or changed activation. Call presentReplyOptions again or wait for revised approval.",
        reason: "activation_confirm_declined",
      });
    }
    return progress(phase, {
      status: "in_progress",
      nextTool: "presentReplyOptions",
      allowedTools: ["presentReplyOptions"],
      instruction: "Wait for the user to answer presentReplyOptions, then call activateLoop.",
      handoffPending: !promptUnanswered && replyEvents.length > 0,
      reason: "activation_confirm_pending",
    });
  }
  return progress(phase, {
    status: "in_progress",
    nextTool: "presentReplyOptions",
    allowedTools: ["presentReplyOptions"],
    instruction: "Call presentReplyOptions to request explicit user confirmation, then activateLoop.",
  });
}

function attachPendingUiTool(
  result: BuildPhaseProgress,
  messages: BuildEvidenceSource,
): BuildPhaseProgress {
  if (!isLoopBuildEventSource(messages)) return result;
  const pendingUiTool = derivePendingUiToolFromEvents(messages);
  if (!pendingUiTool) return result;
  return { ...result, pendingUiTool };
}

export function deriveBuildPhaseProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
  context: BuildPhaseProgressContext = {},
): BuildPhaseProgress {
  const phase = context.effectivePhase ?? state.buildPhase;
  let result: BuildPhaseProgress;
  switch (phase) {
    case "intent":
      result = deriveIntentProgress(state, messages);
      break;
    case "blueprint":
      result = deriveBlueprintProgress();
      break;
    case "connectors":
      result = deriveConnectorProgress(state, messages, context);
      break;
    case "bindings":
      result = deriveBindingProgress(state, messages);
      break;
    case "review":
      result = deriveReviewPhaseProgress(state, messages, context);
      break;
    case "compile":
      result = deriveCompileProgress(state, messages, context);
      break;
    case "test":
      result = deriveTestProgress(state, messages);
      break;
    case "activation":
      result = deriveActivationProgress(state, messages, context);
      break;
    default:
      result = progress(state.buildPhase, {
        instruction: "Continue the current build step.",
        allowedTools: [],
      });
  }
  return attachPendingUiTool(result, messages);
}
