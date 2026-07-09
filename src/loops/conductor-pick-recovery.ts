import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";

import type { PendingUiToolCall } from "./build-events.js";
import {
  completedToolEvents,
  connectorSelectionEvidence,
} from "./build-event-interpreter.js";
import {
  blueprintArtifactSchema,
  type BuildPhase,
  type LoopBuildState,
} from "./build-state.js";
import type { BuildEvidenceSource } from "./build-phase-progress.js";

type DiscoveryGroup = {
  outcomeId: string;
  role: string;
  askOptions?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function latestDiscoveryGroups(messages: BuildEvidenceSource): DiscoveryGroup[] {
  const event = completedToolEvents(messages, "discoverConnectorsForBlueprint").at(-1);
  if (!event || !isRecord(event.output) || !Array.isArray(event.output.groups)) return [];
  return event.output.groups.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const outcomeId = String(raw.outcomeId ?? "").trim();
    const role = String(raw.role ?? "").trim();
    if (!outcomeId || !role) return [];
    return [{
      outcomeId,
      role,
      askOptions: Array.isArray(raw.askOptions) ? raw.askOptions : [],
    }];
  });
}

function hasOpenPickConnectorApp(messages: UIMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      const toolPart = part as {
        type: string;
        toolName?: string;
        state?: string;
        output?: unknown;
      };
      const name = toolPart.type === "dynamic-tool" && toolPart.toolName
        ? toolPart.toolName
        : toolPart.type.replace(/^tool-/, "");
      if (name !== "pickConnectorApp") continue;
      if (toolPart.output != null) continue;
      if (toolPart.state === "input-available" || toolPart.state === "input-streaming") {
        return true;
      }
    }
  }
  return false;
}

export type RecoverMissingPickConnectorAppResult = {
  messages: UIMessage[];
  injected: boolean;
  toolCallId?: string;
  outcomeId?: string;
};

/**
 * Server-owned connector picker. The model must not author this step — discovery
 * already ranked options, and providers with toolChoice "auto" often reason about
 * pickConnectorApp without calling it. Call this before streaming when
 * nextTool === "pickConnectorApp", and again after a stalled model turn.
 */
export function recoverMissingPickConnectorApp(input: {
  messages: UIMessage[];
  state: LoopBuildState;
  pendingUiTool: PendingUiToolCall | null;
  nextTool: string | null | undefined;
  phase: BuildPhase;
}): RecoverMissingPickConnectorAppResult {
  if (input.pendingUiTool) {
    return { messages: input.messages, injected: false };
  }
  if (input.phase !== "connectors" || input.nextTool !== "pickConnectorApp") {
    return { messages: input.messages, injected: false };
  }
  if (hasOpenPickConnectorApp(input.messages)) {
    return { messages: input.messages, injected: false };
  }

  const pendingOutcomes = pendingConnectorOutcomeIds(input.state, input.messages);
  const groups = latestDiscoveryGroups(input.messages);
  const nextGroup = pendingOutcomes
    .map((outcomeId) => groups.find((group) => group.outcomeId === outcomeId))
    .find((group) => group && (group.askOptions?.length ?? 0) > 0);
  if (!nextGroup) {
    return { messages: input.messages, injected: false };
  }
  if (!["trigger", "source", "destination"].includes(nextGroup.role)) {
    return { messages: input.messages, injected: false };
  }

  const toolCallId = `server-pick:${nextGroup.outcomeId}:${createHash("sha256")
    .update(`${nextGroup.outcomeId}:${nextGroup.role}`)
    .digest("hex")
    .slice(0, 12)}`;
  const pickPart = {
    type: "tool-pickConnectorApp" as const,
    toolCallId,
    state: "input-available" as const,
    input: {
      outcomeId: nextGroup.outcomeId,
      role: nextGroup.role as "trigger" | "source" | "destination",
    },
  };

  const last = input.messages.at(-1);
  if (last?.role === "assistant") {
    return {
      messages: input.messages.map((message, index) => (
        index === input.messages.length - 1
          ? { ...message, parts: [...(message.parts ?? []), pickPart] }
          : message
      )),
      injected: true,
      toolCallId,
      outcomeId: nextGroup.outcomeId,
    };
  }

  return {
    messages: [
      ...input.messages,
      {
        id: randomUUID(),
        role: "assistant",
        parts: [pickPart],
      },
    ],
    injected: true,
    toolCallId,
    outcomeId: nextGroup.outcomeId,
  };
}

/** Alias for the proactive (pre-stream) path — same implementation. */
export const ensurePendingPickConnectorApp = recoverMissingPickConnectorApp;
