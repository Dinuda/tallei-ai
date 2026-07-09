import type { AppModelChunk } from "../types.js";

export function textDeltaChunk(text: string): AppModelChunk {
  return { type: "text_delta", text };
}

export function reasoningDeltaChunk(text: string): AppModelChunk {
  return { type: "reasoning_delta", text };
}

export function doneChunk(finishReason?: string | null): AppModelChunk {
  return { type: "done", finishReason: finishReason ?? null };
}

export function errorChunk(error: string): AppModelChunk {
  return { type: "error", error };
}
