import type { UIMessage } from "ai";
import type { LoopBuildEvent } from "./build-events.js";

import { scoreTriggerSlugMatch } from "../integrations/composio/triggers.js";
import { extractConfigurableFields } from "./binding-discovery.js";
import {
  blueprintArtifactSchema,
  connectorArtifactSchema,
  intentArtifactSchema,
  reviewArtifactSchema,
  type LoopBuildState,
} from "./build-state.js";
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

export function interpretConnectorSelections(state: LoopBuildState, messages: BuildEvidenceSource) {
  if (state.buildPhase !== "connectors" || !state.artifacts.blueprint) return null;
  const blueprint = blueprintArtifactSchema.parse(state.artifacts.blueprint.artifact);
  const requiredIds = blueprint.taskBlueprint.outcomes
    .filter((outcome) => outcome.role !== "transform")
    .map((outcome) => outcome.id);
  const selections = new Map<string, string>();
  for (const event of completedToolEvents(messages, "pickConnectorApp")) {
    if (!isRecord(event.output)) continue;
    const outcomeId = String(event.output.outcomeId ?? "").trim();
    const selectedValues = Array.isArray(event.output.selectedValues) ? event.output.selectedValues : [];
    const connector = String(selectedValues[0] ?? "").trim();
    if (requiredIds.includes(outcomeId) && connector && event.output.skipped !== true) selections.set(outcomeId, connector);
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
  for (const event of completedToolEvents(messages, "pickConnectorApp")) {
    if (!isRecord(event.input) || !isRecord(event.output)) continue;
    const outcomeId = String(event.output.outcomeId ?? event.input.outcomeId ?? "").trim();
    const role = String(event.output.role ?? event.input.role ?? "");
    const values = Array.isArray(event.output.selectedValues) ? event.output.selectedValues : [];
    const connector = String(values[0] ?? "").trim();
    if (!outcomeId || !connector || !["trigger", "source", "transform", "destination"].includes(role)) continue;
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
  config: Record<string, unknown>;
};

export function deriveBindingArtifact(
  state: LoopBuildState,
  discoveries: InterpretedBindingDiscovery[],
  triggerLists: InterpretedTriggerList[],
  bindingConfigs: InterpretedBindingConfig[] = [],
) {
  if (state.buildPhase !== "bindings" || !state.artifacts.blueprint || !state.artifacts.connectors) return null;
  const blueprint = blueprintArtifactSchema.parse(state.artifacts.blueprint.artifact);
  const connectors = connectorArtifactSchema.parse(state.artifacts.connectors.artifact);
  const connectorByOutcome = new Map(connectors.selections.map((row) => [row.outcomeId, row.connector]));
  const outcomeById = new Map(blueprint.taskBlueprint.outcomes.map((row) => [row.id, row]));
  const bindingsByOutcome = new Map<string, ToolBinding>();
  for (const discovery of discoveries) {
    for (const raw of discovery.suggestedBindings) {
      if (!isRecord(raw)) continue;
      const outcomeId = String(raw.outcomeId ?? "");
      const outcome = outcomeById.get(outcomeId);
      const connector = String(raw.connector ?? "");
      if (!outcome || outcome.role === "trigger" || connectorByOutcome.get(outcomeId)?.toLowerCase() !== connector.toLowerCase()) continue;
      bindingsByOutcome.set(outcomeId, {
        connector,
        capability: String(raw.capability ?? raw.actionSlug ?? ""),
        actionSlug: String(raw.actionSlug ?? ""),
        role: outcome.role,
      });
    }
  }
  const actionOutcomes = blueprint.taskBlueprint.outcomes.filter((row) => row.role !== "transform" && row.role !== "trigger");
  if (actionOutcomes.some((outcome) => !bindingsByOutcome.has(outcome.id))) return null;

  const triggerOutcome = blueprint.taskBlueprint.outcomes.find((row) => row.role === "trigger");
  let trigger: TriggerConfig = { kind: "manual" };
  if (triggerOutcome) {
    const connector = connectorByOutcome.get(triggerOutcome.id);
    if (!connector) return null;
    const candidates = triggerLists.flatMap((result) =>
      result.toolkit.toLowerCase() === connector.toLowerCase() ? result.triggers : []);
    const ranked = candidates.map((row) => ({
      slug: String(row.slug ?? ""),
      score: scoreTriggerSlugMatch(triggerOutcome.description, String(row.slug ?? ""), String(row.name ?? "")),
      configSchema: isRecord(row.config) ? row.config : {},
      configurableFields: Array.isArray(row.configurableFields)
        ? row.configurableFields.filter(isRecord)
        : extractConfigurableFields(isRecord(row.config) ? row.config : {}),
    })).filter((row) => row.slug).sort((left, right) => right.score - left.score);
    if (!ranked[0]) return null;
    const savedConfig = bindingConfigs.find((entry) =>
      entry.outcomeId === triggerOutcome.id && entry.connector.toLowerCase() === connector.toLowerCase());
    if (ranked[0].configurableFields.length > 0 && !savedConfig) return null;
    trigger = { kind: "event", source: connector, composioSlug: ranked[0].slug, config: savedConfig?.config ?? {} };
  }
  return {
    trigger,
    bindings: actionOutcomes.map((outcome) => bindingsByOutcome.get(outcome.id)!),
    composioActions: [],
    output: { kind: "none" as const },
  };
}

export function bindingEvidenceFromMessages(messages: BuildEvidenceSource) {
  const discoveries = completedToolEvents(messages, "discoverBindings").flatMap((event) => {
    if (!isRecord(event.output) || !Array.isArray(event.output.suggestedBindings)) return [];
    return [{
      toolkit: String(event.output.toolkit ?? ""),
      suggestedBindings: event.output.suggestedBindings.filter(isRecord),
    }];
  });
  const triggerLists = completedToolEvents(messages, "listTriggers").flatMap((event) => {
    if (!isRecord(event.output) || !Array.isArray(event.output.triggers)) return [];
    return [{ toolkit: String(event.output.toolkit ?? ""), triggers: event.output.triggers.filter(isRecord) }];
  });
  const bindingConfigs = completedToolEvents(messages, "setBindingConfig").flatMap((event) => {
    const value = isRecord(event.output) && event.output.ok === true ? event.output : event.input;
    if (!isRecord(value) || !isRecord(value.config)) return [];
    return [{
      outcomeId: String(value.outcomeId ?? ""),
      connector: String(value.connector ?? ""),
      config: value.config,
    }];
  }).filter((entry) => entry.outcomeId && entry.connector);
  return { discoveries, triggerLists, bindingConfigs };
}

export function interpretBindingDiscovery(state: LoopBuildState, messages: BuildEvidenceSource) {
  const evidence = bindingEvidenceFromMessages(messages);
  return deriveBindingArtifact(state, evidence.discoveries, evidence.triggerLists, evidence.bindingConfigs);
}

export function interpretReviewConfirmation(state: LoopBuildState, messages: BuildEvidenceSource) {
  if (state.buildPhase !== "review" || !state.artifacts.bindings) return null;
  const expectedHash = state.artifacts.bindings.artifactHash;
  const confirmed = completedToolEvents(messages, "confirmOutcomeBrief").reverse().find((event) =>
    isRecord(event.output)
    && event.output.action === "confirm"
    && event.output.briefHash === expectedHash,
  );
  if (!confirmed) return null;
  return reviewArtifactSchema.parse({
    bindingHash: expectedHash,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });
}
