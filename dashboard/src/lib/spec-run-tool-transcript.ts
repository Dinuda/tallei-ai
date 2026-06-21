import { isToolUIPart, type UIMessage } from "ai";

export function formatConnectorToolLabel(toolName: string): string {
  const match = toolName.match(/^action_([^_]+)_(.+)$/i);
  if (!match) return toolName.replace(/_/g, " ");
  const toolkit = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  const action = match[2]!.toLowerCase().replace(/_/g, " ");
  return `${toolkit} · ${action}`;
}

export function formatRunToolLabel(toolName: string): string {
  if (toolName === "searchMemory") return "Memory search";
  if (toolName === "searchWeb") return "Web search";
  if (toolName === "getTriggerPayload") return "Trigger payload";
  if (toolName.startsWith("action_")) return formatConnectorToolLabel(toolName);
  return toolName.replace(/_/g, " ");
}

export function toolStateRank(state: string): number {
  if (state === "output-available" || state === "output-error") return 3;
  if (state === "input-available") return 2;
  if (state === "input-streaming") return 1;
  return 0;
}

export function isDataAgentPart(
  part: UIMessage["parts"][number],
): part is { type: "data-agent"; data: Record<string, unknown> } {
  return part.type === "data-agent"
    && "data" in part
    && part.data !== null
    && typeof part.data === "object"
    && !Array.isArray(part.data);
}

/** Replace in-flight tool rows by toolCallId; append new tools in stream order. */
export function mergeToolPartIntoParts(
  merged: UIMessage["parts"],
  part: UIMessage["parts"][number],
): UIMessage["parts"] {
  if (!isToolUIPart(part)) return [...merged, part];

  const toolCallId = part.toolCallId;
  if (!toolCallId) return [...merged, part];

  const existingIndex = merged.findIndex((entry) =>
    isToolUIPart(entry) && entry.toolCallId === toolCallId);
  if (existingIndex < 0) return [...merged, part];

  const existing = merged[existingIndex]!;
  if (!isToolUIPart(existing)) return [...merged, part];
  if (toolStateRank(part.state) < toolStateRank(existing.state)) return merged;

  const next = [...merged];
  next[existingIndex] = part;
  return next;
}

export function isRunToolInProgress(state: string): boolean {
  return state === "input-streaming" || state === "input-available";
}

export function isRunToolComplete(state: string): boolean {
  return state === "output-available";
}

export function resolveRunToolDetail(
  toolName: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): string {
  if (toolName === "searchMemory" || toolName === "searchWeb") {
    return typeof input.query === "string" ? input.query.trim() : "";
  }
  if (toolName === "getTriggerPayload") {
    const ticket = output.ticket && typeof output.ticket === "object" ? output.ticket as Record<string, unknown> : {};
    const subject = typeof ticket.subject === "string" ? ticket.subject.trim() : "";
    if (subject) return subject;
    return "Loaded trigger context";
  }
  if (toolName.startsWith("action_")) {
    if (typeof output.error === "string") return output.error;
    return "";
  }
  return "";
}

export function resolveRunToolMeta(
  toolName: string,
  output: Record<string, unknown>,
): string {
  if (toolName === "searchMemory" || toolName === "searchWeb") {
    const sources = Array.isArray(output.sources) ? output.sources : [];
    if (output.reused === true) return "reused";
    return sources.length === 1 ? "1 source" : `${sources.length} sources`;
  }
  if (toolName === "getTriggerPayload") return "ready";
  if (toolName.startsWith("action_")) return "completed";
  return "";
}
