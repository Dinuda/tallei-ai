/**
 * run-llm.ts — LLM helpers for CEO finalization and text synthesis.
 */

import { loopExecutorOpenAiChat } from "./openai-chat.js";
import type { LoopRunContext } from "./run-context.js";

export async function completeLoopText(input: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await loopExecutorOpenAiChat({
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    temperature: 0.2,
    maxTokens: input.maxTokens ?? 1200,
  });
  const text = response.text.trim();
  if (!text) {
    const usage = response.usage
      ? ` usage=${JSON.stringify(response.usage)}`
      : "";
    throw new Error(`Loop executor LLM returned an empty response (model=${response.model}, finish_reason=${response.finishReason ?? "unknown"}${usage})`);
  }
  return text;
}

/** CEO finalizer: synthesize the comment thread into run output. */
export async function synthesizeFinalOutput(
  context: LoopRunContext,
  comments: Array<{ author: string; body: string }>
): Promise<string> {
  const commentThread = comments
    .map((comment) => `[${comment.author}] ${comment.body}`)
    .join("\n\n")
    .slice(-16_000);
  return completeLoopText({
    system: "You are the CEO finalizer for a recurring loop. Synthesize the agent comments into the final run output. Preserve approval requirements and do not claim external publication occurred.",
    user: [
      `Loop title: ${context.workflowTitle}`,
      `Loop goal: ${context.definition.goal}`,
      "",
      `Comment thread:\n${commentThread || "No comments were posted."}`,
      "",
      "Return the final concise output for the run.",
    ].join("\n"),
    maxTokens: 1800,
  });
}
