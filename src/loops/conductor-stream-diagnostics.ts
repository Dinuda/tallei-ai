import type { UIMessage } from "ai";

export function formatConductorStreamError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (!error || typeof error !== "object") return String(error ?? "unknown error");

  const record = error as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const inner = nested as Record<string, unknown>;
    const code = typeof inner.code === "string" ? inner.code : undefined;
    const message = typeof inner.message === "string" ? inner.message : undefined;
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

type ToolLikePart = {
  type: string;
  toolName?: string;
  state?: string;
};

function resolveToolPartName(part: ToolLikePart): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

export function detectLastVisiblePartType(message: UIMessage | undefined): string | null {
  if (!message) return null;
  const parts = message.parts ?? [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part) continue;
    if (part.type === "text") {
      const text = "text" in part && typeof part.text === "string" ? part.text.trim() : "";
      if (text.length > 0) return "text";
      continue;
    }
    if (part.type === "reasoning") continue;
    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      return `tool:${resolveToolPartName(part as ToolLikePart)}`;
    }
    return part.type;
  }
  return null;
}

export function detectPendingToolState(message: UIMessage | undefined): string | null {
  if (!message) return null;
  for (let index = (message.parts ?? []).length - 1; index >= 0; index -= 1) {
    const part = message.parts?.[index];
    if (!part || (!part.type.startsWith("tool-") && part.type !== "dynamic-tool")) continue;
    const toolPart = part as ToolLikePart;
    const state = toolPart.state ?? "unknown";
    if (state === "input-available" || state === "input-streaming") {
      return `${resolveToolPartName(toolPart)}:${state}`;
    }
  }
  return null;
}

export function summarizeAssistantMessageParts(message: UIMessage | undefined): Array<Record<string, unknown>> {
  if (!message) return [];
  return (message.parts ?? []).map((part) => {
    if (part.type === "reasoning") {
      const text = "text" in part && typeof part.text === "string" ? part.text : "";
      return { type: "reasoning", textLength: text.length, empty: text.trim().length === 0 };
    }
    if (part.type === "text") {
      const text = "text" in part && typeof part.text === "string" ? part.text : "";
      return { type: "text", textLength: text.length };
    }
    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const toolPart = part as { type: string; toolName?: string; state?: string };
      const name = toolPart.type === "dynamic-tool" && toolPart.toolName
        ? toolPart.toolName
        : toolPart.type.replace(/^tool-/, "");
      return { type: "tool", name, state: toolPart.state ?? "unknown" };
    }
    return { type: part.type };
  });
}

export function logConductorTurnStall(input: {
  loopId: string;
  phase: string;
  nextTool: string | null | undefined;
  modelId: string;
  stepsUsed: number;
  streamError: string | null;
  outcome?: string;
  resolutionReason?: string;
  messages: UIMessage[];
  streamElapsedMs?: number;
  stepTimingsMs?: number[];
  pendingUiTool?: { toolName?: string; toolCallId?: string } | null;
}): void {
  const lastAssistant = [...input.messages].reverse().find((message) => message.role === "assistant");
  const parts = summarizeAssistantMessageParts(lastAssistant);
  const reasoningOnly = parts.length > 0
    && parts.every((part) => part.type === "reasoning")
    && parts.every((part) => part.empty === true);

  console.error(`[loops/chat:${input.loopId}] CONDUCTOR TURN STALL`, {
    loopId: input.loopId,
    phase: input.phase,
    requiredNextTool: input.nextTool ?? null,
    modelId: input.modelId,
    stepsUsed: input.stepsUsed,
    streamError: input.streamError,
    outcome: input.outcome ?? null,
    resolutionReason: input.resolutionReason ?? null,
    assistantMessageId: lastAssistant?.id ?? null,
    assistantParts: parts,
    emptyReasoningOnly: reasoningOnly,
    streamElapsedMs: input.streamElapsedMs ?? null,
    stepTimingsMs: input.stepTimingsMs ?? [],
    lastVisiblePartType: detectLastVisiblePartType(lastAssistant),
    pendingToolState: detectPendingToolState(lastAssistant),
    pendingUiTool: input.pendingUiTool ?? null,
    hint: input.streamError
      ? "Model stream failed — check rate limits or API errors above."
      : input.stepsUsed === 0
        ? "Turn ended without calling the required tool — reasoning-only or empty output."
        : "Turn ended without expected progress.",
  });
}
