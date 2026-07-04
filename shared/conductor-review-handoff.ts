import type { ConductorBuildPhase } from "./conductor-turn-budget.js";

type ReviewHandoffMessagePart = {
  type: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
};

type ReviewHandoffMessage = {
  role: string;
  parts?: ReviewHandoffMessagePart[];
};

function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function isSuccessfulPresentAgentTeamOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const row = output as Record<string, unknown>;
  if (row.ok === false) return false;
  const specialists = row.specialists;
  return Array.isArray(specialists) && specialists.length > 0;
}

function hasConfirmedOutcomeBriefInTranscript(messages: ReviewHandoffMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (resolveToolPartName(part) !== "confirmOutcomeBrief") continue;
      if (part.state !== "output-available" || !part.output) continue;
      const output = part.output as { action?: string };
      if (output.action === "confirm") return true;
    }
  }
  return false;
}

function hasUnansweredConfirmOutcomeBrief(messages: ReviewHandoffMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (resolveToolPartName(part) !== "confirmOutcomeBrief") continue;
      if (part.state === "input-available" && part.output == null) return true;
    }
  }
  return false;
}

function hasSuccessfulPresentAgentTeamInTranscript(messages: ReviewHandoffMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (resolveToolPartName(part) !== "presentAgentTeam") continue;
      if (part.state !== "output-available" || !part.output) continue;
      if (isSuccessfulPresentAgentTeamOutput(part.output)) return true;
    }
  }
  return false;
}

/** Review roster is shown but confirmOutcomeBrief has not been answered yet. */
export function isReviewConfirmationHandoffPending(input: {
  messages: ReviewHandoffMessage[];
  buildPhase?: ConductorBuildPhase | null;
}): boolean {
  if (input.buildPhase !== "review") return false;
  if (hasUnansweredConfirmOutcomeBrief(input.messages)) return false;
  if (hasConfirmedOutcomeBriefInTranscript(input.messages)) return false;
  return hasSuccessfulPresentAgentTeamInTranscript(input.messages);
}
