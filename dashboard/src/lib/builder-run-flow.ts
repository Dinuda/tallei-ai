import { getToolName, isToolUIPart, type UIMessage } from "ai";

import type { BuilderCommandSnapshot } from "./builder-session-recovery";

export type BuilderTraceSnapshot = {
  id: string;
  at: string;
  kind: "analyzer_phase" | "chat_turn";
  phase?: string;
  agentLabel?: string;
  systemPrompt?: string;
  handoff?: Array<{ phase: string; agentLabel: string; summary: Record<string, unknown> }>;
  usage?: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    models: Record<string, number>;
  };
  messageCount?: number;
};

export type BuilderRunTimelineEntry =
  | {
      kind: "analyzer_phase";
      at: string;
      id: string;
      phase?: string;
      agentLabel?: string;
      systemPrompt?: string;
      handoff?: BuilderTraceSnapshot["handoff"];
    }
  | {
      kind: "chat_turn";
      at: string;
      id: string;
      messageCount?: number;
      usage?: BuilderTraceSnapshot["usage"];
    }
  | {
      kind: "command";
      at: string;
      id?: string;
      toolName?: string;
      status?: string;
      createdAt?: string;
      updatedAt?: string;
      input: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: string;
      events: BuilderCommandSnapshot["events"];
      usage?: unknown;
    }
  | {
      kind: "message";
      at: string;
      id: string;
      role: string;
      parts: Array<Record<string, unknown>>;
      metadata?: unknown;
    };

export type BuilderRunFlow = {
  timeline: BuilderRunTimelineEntry[];
};

function iso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function messagePartsForFlow(parts: UIMessage["parts"]): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: part.type, text: part.text };
    }
    if (part.type === "reasoning") {
      return { type: part.type, text: part.text, state: part.state };
    }
    if (isToolUIPart(part)) {
      const toolName = getToolName(part);
      const summary: Record<string, unknown> = {
        type: part.type,
        toolName,
        state: part.state,
      };
      if ("input" in part && part.input !== undefined) summary.input = part.input;
      if ("output" in part && part.output !== undefined) summary.output = part.output;
      if ("errorText" in part && typeof part.errorText === "string") summary.errorText = part.errorText;
      return summary;
    }
    return { type: part.type };
  });
}

function timelineSortKey(entry: BuilderRunTimelineEntry): string {
  return `${entry.at}\0${entry.kind}\0${"id" in entry ? entry.id : ""}`;
}

export function buildBuilderRunFlow(input: {
  trace?: BuilderTraceSnapshot[];
  commands?: Array<Record<string, unknown>>;
  messages?: UIMessage[];
}): BuilderRunFlow {
  const timeline: BuilderRunTimelineEntry[] = [];

  for (const entry of input.trace ?? []) {
    if (entry.kind === "analyzer_phase") {
      timeline.push({
        kind: "analyzer_phase",
        at: entry.at,
        id: entry.id,
        phase: entry.phase,
        agentLabel: entry.agentLabel,
        systemPrompt: entry.systemPrompt,
        handoff: entry.handoff,
      });
      continue;
    }
    timeline.push({
      kind: "chat_turn",
      at: entry.at,
      id: entry.id,
      messageCount: entry.messageCount,
      usage: entry.usage,
    });
  }

  for (const command of input.commands ?? []) {
    const createdAt = iso(command.createdAt);
    timeline.push({
      kind: "command",
      at: createdAt ?? iso(command.updatedAt) ?? new Date(0).toISOString(),
      id: typeof command.id === "string" ? command.id : typeof command.jobId === "string" ? command.jobId : undefined,
      toolName: typeof command.toolName === "string" ? command.toolName : undefined,
      status: typeof command.status === "string" ? command.status : undefined,
      createdAt,
      updatedAt: iso(command.updatedAt),
      input: command.input && typeof command.input === "object" && !Array.isArray(command.input)
        ? command.input as Record<string, unknown>
        : {},
      result: command.result && typeof command.result === "object" && !Array.isArray(command.result)
        ? command.result as Record<string, unknown>
        : undefined,
      error: typeof command.error === "string" ? command.error : undefined,
      events: Array.isArray(command.events) ? command.events as BuilderCommandSnapshot["events"] : [],
      usage: command.usage,
    });
  }

  const messageBaseAt = timeline.length > 0
    ? timeline[timeline.length - 1]!.at
    : new Date(0).toISOString();

  (input.messages ?? []).forEach((message, index) => {
    timeline.push({
      kind: "message",
      at: `${messageBaseAt}+msg${String(index).padStart(4, "0")}`,
      id: message.id,
      role: message.role,
      parts: messagePartsForFlow(message.parts),
      metadata: message.metadata,
    });
  });

  timeline.sort((left, right) => timelineSortKey(left).localeCompare(timelineSortKey(right)));

  return { timeline };
}
