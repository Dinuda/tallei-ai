import type { UIMessage } from "ai";
import type { LoopBuildEvent } from "./build-events.js";

import { scoreTriggerSlugMatch } from "../integrations/composio/triggers.js";
import { extractConfigurableFields } from "./binding-discovery.js";
import {
  blueprintArtifactSchema,
  bindingArtifactSchema,
  connectorArtifactSchema,
  intentArtifactSchema,
  projectLoopSpec,
  reviewArtifactSchema,
  type LoopBuildState,
  type BuildPhase,
} from "./build-state.js";
import { computeOutcomeBriefHash } from "./outcome-brief.js";
import type { IntentAnalysis } from "./intent-discovery.js";
import type { LoopSpec, ToolBinding, TriggerConfig } from "./spec.js";

type CompletedToolEvent = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolName(part: { type: string; toolName?: string }): string {
  return part.type === "dynamic-tool" && part.toolName
    ? part.toolName
    : part.type.replace(/^tool-/, "");
}

type BuildEvidenceSource = UIMessage[] | LoopBuildEvent[];

function isLoopBuildEvent(value: UIMessage | LoopBuildEvent | undefined): value is LoopBuildEvent {
  return Boolean(value && "eventKey" in value);
}

export function completedToolEvents(messages: BuildEvidenceSource, name?: string): CompletedToolEvent[] {
  if (isLoopBuildEvent(messages[0])) {
    return (messages as LoopBuildEvent[]).flatMap((event) => {
      if (event.type !== "tool_call.completed") return [];
      const resolvedName = String(event.payload.toolName ?? "");
      if (!event.toolCallId || (name && resolvedName !== name)) return [];
      return [{
        toolCallId: event.toolCallId,
        toolName: resolvedName,
        input: event.payload.input,
        output: event.payload.output,
      }];
    });
  }
  return (messages as UIMessage[]).flatMap((message) => message.role !== "assistant" ? [] : (message.parts ?? []).flatMap((part) => {
    const candidate = part as {
      type: string; toolName?: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown;
    };
    const resolvedName = toolName(candidate);
    if (!candidate.toolCallId || candidate.state !== "output-available" || candidate.output === undefined) return [];
    if (name && resolvedName !== name) return [];
    return [{
      toolCallId: candidate.toolCallId,
      toolName: resolvedName,
      input: candidate.input,
      output: candidate.output,
    }];
  }));
}

export function deriveIntentAndBlueprint(input: {
  spec: LoopSpec;
  analysis: IntentAnalysis;
  answers: Map<string, string>;
  connectedToolkits: Array<{ slug: string; name: string }>;
  existingSourceHints?: Array<{ channel: string; userMentionedApp?: string }>;
}) {
  const decisions = input.analysis.questions.map((question) => ({
    questionId: question.id,
    question: question.question,
    answer: input.answers.get(question.id) ?? "",
  }));
  if (decisions.some((decision) => !decision.answer)) return null;

  const sourceText = `${input.spec.intent.goal} ${input.analysis.outcome} ${input.analysis.trigger}`.toLowerCase();
  const discoveredSourceHints = input.connectedToolkits.flatMap((toolkit) => {
    const mentioned = sourceText.includes(toolkit.name.toLowerCase()) || sourceText.includes(toolkit.slug.toLowerCase());
    return mentioned ? [{ channel: input.analysis.trigger, userMentionedApp: toolkit.name }] : [];
  });
  const sourceHints = [...(input.existingSourceHints ?? []), ...discoveredSourceHints]
    .filter((hint, index, all) => all.findIndex((candidate) =>
      candidate.channel.toLowerCase() === hint.channel.toLowerCase()
      && candidate.userMentionedApp?.toLowerCase() === hint.userMentionedApp?.toLowerCase()) === index);
  const analysis = { ...input.analysis, decisions };
  const intent = intentArtifactSchema.parse({
    workspaceId: input.spec.workspaceId,
    intent: {
      ...input.spec.intent,
      outcome: input.analysis.outcome,
    },
    startCondition: input.analysis.trigger,
    sourceHints,
    analysis,
  });
  const blueprint = blueprintArtifactSchema.parse({
    taskBlueprint: {
      version: 1,
      summary: input.analysis.outcome,
      outcomes: input.analysis.executionOrder.map((step, index) => ({
        id: `step-${index + 1}`,
        role: step.role,
        description: step.description,
        status: "pending" as const,
      })),
    },
    profile: "agentic",
    agent: {
      instructions: `Complete this workflow in order: ${input.analysis.executionOrder.map((step) => step.description).join("; ")}`,
      maxSteps: 12,
      maxTokens: 8_000,
    },
    approval: input.analysis.approval ?? input.spec.approval,
    guardrails: input.spec.guardrails,
  });
  return { intent, blueprint };
}

export function interpretCompletedIntent(input: {
  state: LoopBuildState;
  spec: LoopSpec;
  messages: BuildEvidenceSource;
  connectedToolkits: Array<{ slug: string; name: string }>;
}) {
  if (input.state.buildPhase !== "intent") return null;
  const analysisEvent = completedToolEvents(input.messages, "analyzeIntent").at(-1);
  if (!analysisEvent) return null;
  const rawAnalysis = isRecord(analysisEvent.output) && isRecord(analysisEvent.output.analysis)
    ? analysisEvent.output.analysis
    : analysisEvent.input;
  const answers = new Map<string, string>();
  for (const event of completedToolEvents(input.messages, "askQuestion")) {
    if (!isRecord(event.output)) continue;
    const questionId = String(event.output.questionId ?? "").trim();
    const answer = String(event.output.answerText ?? "").trim();
    if (questionId && answer && answer !== "skipped") answers.set(questionId, answer);
  }
  try {
    return deriveIntentAndBlueprint({
      spec: input.spec,
      analysis: rawAnalysis as IntentAnalysis,
      answers,
      connectedToolkits: input.connectedToolkits,
      existingSourceHints: input.state.artifacts.intent
        ? intentArtifactSchema.parse(input.state.artifacts.intent.artifact).sourceHints
        : [],
    });
  } catch {
    return null;
  }
}

function discoveredConnectorOptions(messages: BuildEvidenceSource): Map<string, Set<string>> {
  const optionsByOutcome = new Map<string, Set<string>>();
  for (const event of completedToolEvents(messages, "discoverConnectorsForBlueprint")) {
    if (!isRecord(event.output) || !Array.isArray(event.output.groups)) continue;
    for (const rawGroup of event.output.groups) {
      if (!isRecord(rawGroup) || !Array.isArray(rawGroup.askOptions)) continue;
      const outcomeId = String(rawGroup.outcomeId ?? "").trim();
      if (!outcomeId) continue;
      const options = new Set(rawGroup.askOptions.flatMap((rawOption) => {
        if (!isRecord(rawOption)) return [];
        const value = String(rawOption.value ?? "").trim().toLowerCase();
        return value ? [value] : [];
      }));
      if (options.size > 0) optionsByOutcome.set(outcomeId, options);
    }
  }
  return optionsByOutcome;
}

function connectorWasDiscovered(
  optionsByOutcome: Map<string, Set<string>>,
  outcomeId: string,
  connector: string,
): boolean {
  const allowed = optionsByOutcome.get(outcomeId);
  return !allowed || allowed.has(connector.toLowerCase());
}

export function interpretConnectorSelections(state: LoopBuildState, messages: BuildEvidenceSource) {
  if (state.buildPhase !== "connectors" || !state.artifacts.blueprint) return null;
  const blueprint = blueprintArtifactSchema.parse(state.artifacts.blueprint.artifact);
  const requiredIds = blueprint.taskBlueprint.outcomes
    .filter((outcome) => outcome.role !== "transform")
    .map((outcome) => outcome.id);
  const selections = new Map<string, string>();
  const optionsByOutcome = discoveredConnectorOptions(messages);
  for (const event of completedToolEvents(messages, "pickConnectorApp")) {
    if (!isRecord(event.output)) continue;
    const outcomeId = String(event.output.outcomeId ?? "").trim();
    const selectedValues = Array.isArray(event.output.selectedValues) ? event.output.selectedValues : [];
    const connector = String(selectedValues[0] ?? "").trim();
    if (requiredIds.includes(outcomeId) && connector && event.output.skipped !== true
      && connectorWasDiscovered(optionsByOutcome, outcomeId, connector)) selections.set(outcomeId, connector);
  }
  for (const event of completedToolEvents(messages, "discoverConnectorsForBlueprint")) {
    if (!isRecord(event.output)) continue;
    if (Array.isArray(event.output.groups)) {
      for (const raw of event.output.groups) {
        if (!isRecord(raw) || !Array.isArray(raw.linkedOutcomeIds)) continue;
        const connector = selections.get(String(raw.outcomeId ?? ""));
        if (!connector) continue;
        for (const linkedId of raw.linkedOutcomeIds) {
          const outcomeId = String(linkedId);
          if (requiredIds.includes(outcomeId)) selections.set(outcomeId, connector);
        }
      }
    }
    if (!Array.isArray(event.output.autoResolved)) continue;
    for (const raw of event.output.autoResolved) {
      if (!isRecord(raw)) continue;
      const outcomeId = String(raw.outcomeId ?? "").trim();
      const connector = String(raw.connector ?? "").trim();
      if (requiredIds.includes(outcomeId) && connector) selections.set(outcomeId, connector);
    }
  }
  if (isLoopBuildEvent(messages[0])) {
    for (const event of messages as LoopBuildEvent[]) {
      if (event.type !== "connector.auto_resolved") continue;
      const outcomeId = String(event.payload.outcomeId ?? "");
      const connector = String(event.payload.connector ?? "");
      if (requiredIds.includes(outcomeId) && connector) selections.set(outcomeId, connector);
    }
  }
  if (requiredIds.some((outcomeId) => !selections.has(outcomeId))) return null;
  return connectorArtifactSchema.parse({
    selections: requiredIds.map((outcomeId) => ({
      outcomeId,
      connector: selections.get(outcomeId)!,
      confirmedByUser: true,
    })),
  });
}

export function connectorSelectionEvidence(
  messages: BuildEvidenceSource,
): Array<{ outcomeId: string; role: "trigger" | "source" | "transform" | "destination"; connector: string }> {
  const selections = new Map<string, { outcomeId: string; role: "trigger" | "source" | "transform" | "destination"; connector: string }>();
  const optionsByOutcome = discoveredConnectorOptions(messages);
  for (const event of completedToolEvents(messages, "pickConnectorApp")) {
    if (!isRecord(event.input) || !isRecord(event.output)) continue;
    const outcomeId = String(event.output.outcomeId ?? event.input.outcomeId ?? "").trim();
    const role = String(event.output.role ?? event.input.role ?? "");
    const values = Array.isArray(event.output.selectedValues) ? event.output.selectedValues : [];
    const connector = String(values[0] ?? "").trim();
    if (!outcomeId || !connector || !["trigger", "source", "transform", "destination"].includes(role)
      || !connectorWasDiscovered(optionsByOutcome, outcomeId, connector)) continue;
    selections.set(outcomeId, { outcomeId, role: role as "trigger" | "source" | "transform" | "destination", connector });
  }
  for (const event of completedToolEvents(messages, "discoverConnectorsForBlueprint")) {
    if (!isRecord(event.output)) continue;
    if (Array.isArray(event.output.groups)) {
      for (const raw of event.output.groups) {
        if (!isRecord(raw) || !Array.isArray(raw.linkedOutcomeIds)) continue;
        const source = selections.get(String(raw.outcomeId ?? ""));
        if (!source) continue;
        for (const linkedId of raw.linkedOutcomeIds) {
          const outcomeId = String(linkedId);
          selections.set(outcomeId, { outcomeId, role: "source", connector: source.connector });
        }
      }
    }
    if (!Array.isArray(event.output.autoResolved)) continue;
    for (const raw of event.output.autoResolved) {
      if (!isRecord(raw)) continue;
      const outcomeId = String(raw.outcomeId ?? "");
      const role = String(raw.role ?? "");
      const connector = String(raw.connector ?? "");
      if (outcomeId && connector && ["trigger", "source", "transform", "destination"].includes(role)) {
        selections.set(outcomeId, { outcomeId, role: role as "trigger" | "source" | "transform" | "destination", connector });
      }
    }
  }
  return [...selections.values()];
}

export type InterpretedBindingDiscovery = {
  toolkit: string;
  suggestedBindings: Array<Record<string, unknown>>;
};
export type InterpretedTriggerList = {
  toolkit: string;
  triggers: Array<Record<string, unknown>>;
};
export type InterpretedBindingConfig = {
  outcomeId: string;
  connector: string;
  triggerSlug?: string;
  config: Record<string, unknown>;
};

export type BindingDiagnosticCode =
  | "MISSING_ACTION_BINDING"
  | "MISSING_TRIGGER"
  | "MISSING_TRIGGER_CONFIG"
  | "UNKNOWN_OUTCOME"
  | "INVALID_OUTCOME_ROLE"
  | "OUTCOME_CONNECTOR_MISMATCH"
  | "DUPLICATE_ACTION_BINDING"
  | "DISCOVERY_INPUT_MISMATCH"
  | "INVALID_ACTION_OVERRIDE"
  | "AMBIGUOUS_ACTION_BINDING"
  | "AMBIGUOUS_TRIGGER"
  | "INVALID_TRIGGER_SELECTION"
  | "CONNECTOR_NOT_CONNECTED"
  | "UNSUPPORTED_TRIGGER_CONFIG"
  | "INVALID_TRIGGER_CONFIG"
  | "BINDING_RESOLUTION_FAILED"
  | "BINDING_RESOLVER_PROVIDER_ERROR"
  | "INVALID_BINDING_SCOPE_ANSWER";

export type BindingDiagnostic = {
  code: BindingDiagnosticCode;
  message: string;
  outcomeId?: string;
  outcome?: string;
  connector?: string;
  rejectedValue?: string;
  expected: string;
  action: string;
  options?: Array<{ label: string; value: string; description: string }>;
  technical: Record<string, string | number | boolean>;
};

export type BindingDerivationResult = {
  artifact: ReturnType<typeof deriveCompleteBindingArtifact> | null;
  diagnostics: BindingDiagnostic[];
};

export function bindingActionOutcomesForToolkit(spec: LoopSpec, toolkit: string) {
  const normalizedToolkit = toolkit.toLowerCase();
  return (spec.taskBlueprint?.outcomes ?? []).filter((outcome) =>
    outcome.role !== "trigger"
    && outcome.role !== "transform"
    && outcome.selectedConnector?.toLowerCase() === normalizedToolkit);
}

function diagnostic(input: Omit<BindingDiagnostic, "technical"> & { technical?: BindingDiagnostic["technical"] }): BindingDiagnostic {
  return { ...input, technical: input.technical ?? {} };
}

function deriveCompleteBindingArtifact(input: {
  trigger: TriggerConfig;
  bindings: ToolBinding[];
}) {
  return {
    trigger: input.trigger,
    bindings: input.bindings,
    composioActions: [],
    output: { kind: "none" as const },
  };
}

export function deriveBindingArtifactResult(
  state: LoopBuildState,
  discoveries: InterpretedBindingDiscovery[],
  triggerLists: InterpretedTriggerList[],
  bindingConfigs: InterpretedBindingConfig[] = [],
): BindingDerivationResult {
  if (!["bindings", "review", "compile"].includes(state.buildPhase) || !state.artifacts.blueprint || !state.artifacts.connectors) {
    return { artifact: null, diagnostics: [] };
  }
  const blueprint = blueprintArtifactSchema.parse(state.artifacts.blueprint.artifact);
  const connectors = connectorArtifactSchema.parse(state.artifacts.connectors.artifact);
  const connectorByOutcome = new Map(connectors.selections.map((row) => [row.outcomeId, row.connector]));
  const outcomeById = new Map(blueprint.taskBlueprint.outcomes.map((row) => [row.id, row]));
  const bindingsByOutcome = new Map<string, ToolBinding>();
  const diagnostics: BindingDiagnostic[] = [];

  for (const discovery of discoveries) {
    for (const raw of discovery.suggestedBindings) {
      if (!isRecord(raw)) continue;
      const outcomeId = String(raw.outcomeId ?? "");
      const outcome = outcomeById.get(outcomeId);
      const connector = String(raw.connector ?? "");
      const actionSlug = String(raw.actionSlug ?? "");
      if (!outcome) {
        diagnostics.push(diagnostic({
          code: "UNKNOWN_OUTCOME", message: "A discovered action refers to an unknown workflow step.", outcomeId,
          connector, rejectedValue: actionSlug, expected: "An existing outcome ID from the current workflow",
          action: "Discover the action again for the current workflow step.", technical: { outcomeId, connector, actionSlug },
        }));
        continue;
      }
      if (outcome.role === "trigger" || outcome.role === "transform") {
        diagnostics.push(diagnostic({
          code: "INVALID_OUTCOME_ROLE", message: `The action ${actionSlug || "mapping"} cannot be used for ${outcome.description}.`,
          outcomeId, outcome: outcome.description, connector, rejectedValue: actionSlug,
          expected: outcome.role === "trigger" ? "A trigger selected from the trigger catalogue" : "No provider action for a transform step",
          action: outcome.role === "trigger" ? "Select a trigger for this step." : "Remove this provider action.",
          technical: { outcomeId, role: outcome.role, connector, actionSlug },
        }));
        continue;
      }
      const expectedConnector = connectorByOutcome.get(outcomeId);
      if (!expectedConnector || expectedConnector.toLowerCase() !== connector.toLowerCase()) {
        diagnostics.push(diagnostic({
          code: "OUTCOME_CONNECTOR_MISMATCH", message: `${outcome.description} is assigned to ${expectedConnector ?? "no connector"}, not ${connector || "the discovered connector"}.`,
          outcomeId, outcome: outcome.description, connector, rejectedValue: connector,
          expected: expectedConnector ?? "A selected connector",
          action: `Discover this action using ${expectedConnector ?? "the selected connector"}.`,
          technical: { outcomeId, expectedConnector: expectedConnector ?? "", actualConnector: connector, actionSlug },
        }));
        continue;
      }
      if (bindingsByOutcome.has(outcomeId)) {
        const existing = bindingsByOutcome.get(outcomeId)!;
        if (existing.connector.toLowerCase() === connector.toLowerCase() && existing.actionSlug === actionSlug) continue;
        diagnostics.push(diagnostic({
          code: "DUPLICATE_ACTION_BINDING", message: `${outcome.description} has more than one action mapping.`,
          outcomeId, outcome: outcome.description, connector, rejectedValue: actionSlug,
          expected: "Exactly one verified action mapping", action: "Choose one action for this workflow step.",
          technical: { outcomeId, connector, actionSlug },
        }));
        continue;
      }
      bindingsByOutcome.set(outcomeId, {
        connector, capability: String(raw.capability ?? raw.actionSlug ?? ""), actionSlug, role: outcome.role,
      });
    }
  }

  const actionOutcomes = blueprint.taskBlueprint.outcomes.filter((row) => row.role !== "transform" && row.role !== "trigger");
  for (const outcome of actionOutcomes) {
    if (bindingsByOutcome.has(outcome.id)) continue;
    const connector = connectorByOutcome.get(outcome.id);
    diagnostics.push(diagnostic({
      code: "MISSING_ACTION_BINDING", message: `No action is mapped for ${outcome.description}.`,
      outcomeId: outcome.id, outcome: outcome.description, connector,
      expected: `One verified ${connector ?? "connector"} action`, action: `Discover and select an action for ${outcome.description}.`,
      technical: { outcomeId: outcome.id, role: outcome.role, connector: connector ?? "" },
    }));
  }

  const triggerOutcome = blueprint.taskBlueprint.outcomes.find((row) => row.role === "trigger");
  let trigger: TriggerConfig = { kind: "manual" };
  if (triggerOutcome) {
    const connector = connectorByOutcome.get(triggerOutcome.id);
    const candidates = connector ? triggerLists.flatMap((result) =>
      result.toolkit.toLowerCase() === connector.toLowerCase() ? result.triggers : []) : [];
    const ranked = candidates.map((row) => ({
      slug: String(row.slug ?? ""), name: String(row.name ?? ""),
      score: scoreTriggerSlugMatch(triggerOutcome.description, String(row.slug ?? ""), String(row.name ?? "")),
      configurableFields: Array.isArray(row.configurableFields) ? row.configurableFields.filter(isRecord)
        : extractConfigurableFields(isRecord(row.config) ? row.config : {}),
    })).filter((row) => row.slug).sort((left, right) => right.score - left.score);
    if (!connector || !ranked[0]) {
      diagnostics.push(diagnostic({
        code: "MISSING_TRIGGER", message: `No event trigger is mapped for ${triggerOutcome.description}.`,
        outcomeId: triggerOutcome.id, outcome: triggerOutcome.description, connector,
        expected: `One verified ${connector ?? "connector"} trigger`, action: "List and select a trigger for this workflow step.",
        technical: { outcomeId: triggerOutcome.id, connector: connector ?? "" },
      }));
    } else {
      const savedConfig = bindingConfigs.find((entry) => entry.outcomeId === triggerOutcome.id
        && entry.connector.toLowerCase() === connector.toLowerCase());
      const closeTriggers = ranked.filter((candidate) => candidate.score >= ranked[0]!.score - 1);
      const selectedTrigger = savedConfig?.triggerSlug
        ? ranked.find((candidate) => candidate.slug === savedConfig.triggerSlug)
        : closeTriggers.length === 1 ? ranked[0] : undefined;
      if (!selectedTrigger) {
        diagnostics.push(diagnostic({
          code: "AMBIGUOUS_TRIGGER", message: `More than one ${connector} trigger could start ${triggerOutcome.description}.`,
          outcomeId: triggerOutcome.id, outcome: triggerOutcome.description, connector,
          expected: "One explicitly selected provider trigger", action: "Choose the trigger that matches the intended event.",
          options: closeTriggers.slice(0, 5).map((candidate) => ({
            label: candidate.name || candidate.slug, value: candidate.slug, description: candidate.slug,
          })),
          technical: { outcomeId: triggerOutcome.id, connector, candidateSlugs: closeTriggers.map((candidate) => candidate.slug).join(",") },
        }));
      } else if (selectedTrigger.configurableFields.length > 0 && !savedConfig) {
        diagnostics.push(diagnostic({
          code: "MISSING_TRIGGER_CONFIG", message: `${triggerOutcome.description} needs one scope choice before it can be saved.`,
          outcomeId: triggerOutcome.id, outcome: triggerOutcome.description, connector, rejectedValue: selectedTrigger.slug,
          expected: `Configuration for ${selectedTrigger.configurableFields.map((field) => String(field.key)).join(", ")}`,
          action: "Answer the trigger scope question.",
          technical: { outcomeId: triggerOutcome.id, connector, triggerSlug: selectedTrigger.slug },
        }));
      } else {
        trigger = { kind: "event", source: connector, composioSlug: selectedTrigger.slug, config: savedConfig?.config ?? {} };
      }
    }
  }

  if (diagnostics.length > 0) return { artifact: null, diagnostics };
  return { artifact: deriveCompleteBindingArtifact({
    trigger, bindings: actionOutcomes.map((outcome) => bindingsByOutcome.get(outcome.id)!),
  }), diagnostics: [] };
}

export function deriveBindingArtifact(
  state: LoopBuildState,
  discoveries: InterpretedBindingDiscovery[],
  triggerLists: InterpretedTriggerList[],
  bindingConfigs: InterpretedBindingConfig[] = [],
) {
  return deriveBindingArtifactResult(state, discoveries, triggerLists, bindingConfigs).artifact;
}

export function bindingEvidenceFromMessages(messages: BuildEvidenceSource) {
  const discoveryRows = completedToolEvents(messages, "discoverBindings").flatMap((event) => {
    if (!isRecord(event.output) || !Array.isArray(event.output.suggestedBindings)) return [];
    return [{
      toolkit: String(event.output.toolkit ?? ""),
      suggestedBindings: event.output.suggestedBindings.filter(isRecord),
    }];
  });
  const latestDiscoveryByToolkit = new Map<string, InterpretedBindingDiscovery>();
  for (const discovery of discoveryRows) latestDiscoveryByToolkit.set(discovery.toolkit.toLowerCase(), discovery);
  const discoveries = [...latestDiscoveryByToolkit.values()];
  const triggerRows = completedToolEvents(messages, "listTriggers").flatMap((event) => {
    if (!isRecord(event.output) || !Array.isArray(event.output.triggers)) return [];
    return [{ toolkit: String(event.output.toolkit ?? ""), triggers: event.output.triggers.filter(isRecord) }];
  });
  const latestTriggersByToolkit = new Map<string, InterpretedTriggerList>();
  for (const triggerList of triggerRows) latestTriggersByToolkit.set(triggerList.toolkit.toLowerCase(), triggerList);
  const triggerLists = [...latestTriggersByToolkit.values()];
  const bindingConfigs = completedToolEvents(messages, "setBindingConfig").flatMap((event) => {
    const value = isRecord(event.output) && event.output.ok === true ? event.output : event.input;
    if (!isRecord(value) || !isRecord(value.config)) return [];
    return [{
      outcomeId: String(value.outcomeId ?? ""),
      connector: String(value.connector ?? ""),
      ...(typeof value.triggerSlug === "string" ? { triggerSlug: value.triggerSlug } : {}),
      config: value.config,
    }];
  }).filter((entry) => entry.outcomeId && entry.connector);
  return { discoveries, triggerLists, bindingConfigs };
}

export function interpretBindingDiscovery(state: LoopBuildState, messages: BuildEvidenceSource) {
  if (isLoopBuildEvent(messages[0])) {
    const resolved = [...messages as LoopBuildEvent[]].reverse().find((event) =>
      event.type === "binding.resolved"
      && event.payload.blueprintHash === state.artifacts.blueprint?.artifactHash
      && event.payload.connectorHash === state.artifacts.connectors?.artifactHash);
    const parsed = bindingArtifactSchema.safeParse(resolved?.payload.artifact);
    if (parsed.success && ["bindings", "review", "compile"].includes(state.buildPhase)) return parsed.data;
  }
  const evidence = bindingEvidenceFromMessages(messages);
  return deriveBindingArtifact(state, evidence.discoveries, evidence.triggerLists, evidence.bindingConfigs);
}

function isAcceptedReviewBriefHash(state: LoopBuildState, briefHash: string): boolean {
  if (!state.artifacts.bindings) return false;
  const bindingHash = state.artifacts.bindings.artifactHash;
  if (briefHash === bindingHash) return true;
  return briefHash === computeOutcomeBriefHash(projectLoopSpec(state));
}

export function interpretReviewConfirmation(state: LoopBuildState, messages: BuildEvidenceSource) {
  if (state.buildPhase !== "review" || !state.artifacts.bindings) return null;
  const bindingHash = state.artifacts.bindings.artifactHash;
  const confirmed = completedToolEvents(messages, "confirmOutcomeBrief").reverse().find((event) =>
    isRecord(event.output)
    && event.output.action === "confirm"
    && typeof event.output.briefHash === "string"
    && isAcceptedReviewBriefHash(state, event.output.briefHash),
  );
  if (!confirmed) return null;
  return reviewArtifactSchema.parse({
    bindingHash,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });
}

export type ReviewHandoffTool = "presentAgentTeam" | "confirmOutcomeBrief";

export type ReviewProgress = {
  bindingHash: string;
  rosterPrepared: boolean;
  confirmationComplete: boolean;
  nextTool: ReviewHandoffTool | null;
};

function reviewRosterTarget(bindingHash: string): string {
  return `review:${bindingHash}`;
}

function isSuccessfulPresentAgentTeam(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (output.ok === false) return false;
  const specialists = output.specialists;
  return Array.isArray(specialists) && specialists.length > 0;
}

/** Derive the next required review tool from persisted build evidence for the current bindings revision. */
export function deriveReviewProgress(
  state: LoopBuildState,
  messages: BuildEvidenceSource,
  options?: { effectivePhase?: BuildPhase },
): ReviewProgress | null {
  const phase = options?.effectivePhase ?? state.buildPhase;
  if (phase !== "review" || !state.artifacts.bindings) return null;
  const bindingHash = state.artifacts.bindings.artifactHash;
  const rosterTarget = reviewRosterTarget(bindingHash);
  const rosterPrepared = completedToolEvents(messages, "presentAgentTeam").some((event) => {
    if (!isSuccessfulPresentAgentTeam(event.output)) return false;
    const metadata = isRecord(event.output) ? event.output : {};
    if (metadata.operationKey === `review:${bindingHash}:presentAgentTeam:${rosterTarget}`) return true;
    if (metadata.parentArtifactHash === bindingHash) return true;
    return false;
  });
  const confirmationComplete = Boolean(interpretReviewConfirmation(state, messages));
  const nextTool: ReviewHandoffTool | null = confirmationComplete
    ? null
    : rosterPrepared
      ? "confirmOutcomeBrief"
      : "presentAgentTeam";
  return {
    bindingHash,
    rosterPrepared,
    confirmationComplete,
    nextTool,
  };
}
