import type { UIMessage } from "ai";

export type LoopBuildMeta = {
  compiledPlanId: string | null;
};

export function stepToChatMessages(input: {
  stepIndex: number;
  kind: string;
  toolId?: string;
  inputJson?: unknown;
  outputJson?: unknown;
  status: string;
}): UIMessage[] {
  const idBase = `run-step-${input.stepIndex}`;
  if (input.kind === "plan") {
    const decision = input.outputJson as { kind?: string; toolId?: string; summary?: string } | null;
    if (decision?.kind === "finish") {
      return [{
        id: `${idBase}-finish`,
        role: "assistant",
        parts: [{ type: "text", text: decision.summary ?? "Run completed." }],
      }];
    }
    if (decision?.kind === "tool_call") {
      return [{
        id: `${idBase}-plan`,
        role: "assistant",
        parts: [{
          type: `tool-${decision.toolId ?? "tool"}` as "tool-invocation",
          toolCallId: `${idBase}-call`,
          state: "output-available",
          input: input.inputJson ?? {},
          output: input.outputJson,
        } as UIMessage["parts"][number]],
      }];
    }
    return [{
      id: `${idBase}-plan`,
      role: "assistant",
      parts: [{ type: "text", text: JSON.stringify(input.outputJson ?? {}, null, 2) }],
    }];
  }

  if (input.kind === "tool") {
    return [{
      id: `${idBase}-tool`,
      role: "assistant",
      parts: [{
        type: `tool-${input.toolId ?? "execute"}` as "tool-invocation",
        toolCallId: `${idBase}-tool-call`,
        state: input.status === "failed" ? "output-error" : "output-available",
        input: input.inputJson ?? {},
        output: input.outputJson,
        ...(input.status === "failed"
          ? { errorText: String((input.outputJson as { error?: string })?.error ?? "Tool failed") }
          : {}),
      } as UIMessage["parts"][number]],
    }];
  }

  return [{
    id: `${idBase}-event`,
    role: "assistant",
    parts: [{ type: "text", text: `${input.kind}: ${input.status}` }],
  }];
}

export function runStatusToChatMessage(input: {
  runId: string;
  status: "completed" | "failed";
  summary?: string;
  error?: string;
}): UIMessage {
  return {
    id: `run-${input.runId}-${input.status}`,
    role: "assistant",
    parts: [{
      type: "text",
      text: input.status === "completed"
        ? (input.summary ?? "Run completed.")
        : (input.error ?? "Run failed."),
    }],
  };
}

export { normalizeConductorChatMessages, prepareConductorChatMessagesForEventLog } from "./conductor-chat.js";
