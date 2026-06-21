import { getToolName, isToolUIPart, type UIMessage } from "ai";

function toolStateRank(state: string): number {
  if (state === "output-available" || state === "output-error") return 3;
  if (state === "input-available") return 2;
  if (state === "input-streaming") return 1;
  return 0;
}

function isDataAgentPart(part: unknown): boolean {
  return typeof part === "object" && part !== null
    && (part as { type?: string }).type === "data-agent";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function toolLogicalSignature(part: UIMessage["parts"][number]): string | null {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  if (!toolName) return null;
  const normalizedToolName = toolName.trim();
  const isReadOrSearchTool = normalizedToolName === "searchMemory"
    || normalizedToolName === "searchWeb"
    || normalizedToolName.startsWith("action_");
  if (!isReadOrSearchTool) return null;
  return `${normalizedToolName}:${stableJson(part.input ?? {})}`;
}

function shouldReplaceToolPart(
  existing: UIMessage["parts"][number],
  incoming: UIMessage["parts"][number],
): boolean {
  if (!isToolUIPart(existing) || !isToolUIPart(incoming)) return true;
  if (toolStateRank(incoming.state) < toolStateRank(existing.state)) return false;
  if (toolStateRank(incoming.state) > toolStateRank(existing.state)) return true;
  const existingHasOutput = "output" in existing && existing.output !== undefined;
  const incomingHasOutput = "output" in incoming && incoming.output !== undefined;
  return incomingHasOutput || !existingHasOutput;
}

export function mergeToolPartIntoParts(
  merged: UIMessage["parts"],
  part: UIMessage["parts"][number],
): UIMessage["parts"] {
  if (!isToolUIPart(part)) return [...merged, part];

  const toolCallId = part.toolCallId;
  const signature = toolLogicalSignature(part);
  const existingIndex = merged.findIndex((entry) => {
    if (!isToolUIPart(entry)) return false;
    if (toolCallId && entry.toolCallId === toolCallId) return true;
    return Boolean(signature && toolLogicalSignature(entry) === signature);
  });
  if (existingIndex < 0) return [...merged, part];

  const existing = merged[existingIndex]!;
  if (!isToolUIPart(existing)) return [...merged, part];
  if (!shouldReplaceToolPart(existing, part)) return merged;

  const next = [...merged];
  next[existingIndex] = part;
  return next;
}

export function mergePartsForStep(messages: UIMessage[]): UIMessage["parts"] {
  const merged: UIMessage["parts"] = [];

  for (const message of messages) {
    const startsNewGeneration = message.parts.some(isDataAgentPart);
    if (startsNewGeneration && merged.some((part) => part.type === "text" || part.type === "reasoning" || part.type.startsWith("reasoning-"))) {
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        const part = merged[index]!;
        if (part.type === "text" || part.type === "reasoning" || part.type.startsWith("reasoning-")) {
          merged.splice(index, 1);
        }
      }
    }

    for (const part of message.parts) {
      if (isDataAgentPart(part)) {
        if (!merged.some(isDataAgentPart)) merged.push(part);
        continue;
      }
      if (isToolUIPart(part)) {
        const next = mergeToolPartIntoParts(merged, part);
        merged.length = 0;
        merged.push(...next);
        continue;
      }
      if (part.type === "text") {
        const text = part.text?.trim() ?? "";
        if (!text) continue;
        const last = merged[merged.length - 1];
        if (last?.type === "text") {
          const existing = last.text?.trim() ?? "";
          if (existing === text) continue;
          if (text.startsWith(existing)) {
            merged[merged.length - 1] = part;
            continue;
          }
          if (existing.startsWith(text)) continue;
        }
        merged.push(part);
        continue;
      }
      merged.push(part);
    }
  }

  return merged;
}
