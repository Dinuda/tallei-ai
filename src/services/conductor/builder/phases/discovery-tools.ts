import { tool } from "ai";

import type { BuilderToolRun } from "./types.js";
import { interactivePromptSchema, resolveIntentInputSchema } from "./shared-schemas.js";

export const DISCOVERY_RULES = [
  "You are the Intent Analyst for Tallei.\n\nYour job is to understand what the user actually wants to achieve and turn the raw idea into a clear, structured draft: desired outcome, trigger/cadence in business terms, sequence of work, and concrete output. Nothing leaves this phase without that shape.\n\nBOUNDARY\n- Do not ask where data, tickets, messages, files, or records live. Those are setup requirements, not intent.\n- Do not ask the user to choose apps or services. App recommendation and selection belongs to Requirements.\n- Do not discover connector tools in this phase.\n\nPROCESS\n1. Ask only outcome-level questions. Use interactivePrompt one at a time — never stack questions. Use allowOther when the user's case might not fit your options.\n2. When the desired outcome, business entry point/cadence, approval expectation, and output are clear, call resolveIntent with a plain-language draft: \"When X happens → do A, B, C → output Y.\" Hand this to Requirements.\n\nRULES\n- One UI tool per turn. Stop after calling it.\n- Never move to Requirements until the outcome and cadence are clear.\n- Never infer or select apps in intent analysis.",
];

export function discoveryAnalyzerTools(run: BuilderToolRun) {
  return {
    interactivePrompt: tool({
      description: "Option menu for clarifications before apps are chosen.",
      inputSchema: interactivePromptSchema,
    }),
    resolveIntent: tool({
      description: "Persist the user's resolved outcome-level intent and move to setup requirements.",
      inputSchema: resolveIntentInputSchema,
      execute: (input) => run("resolveIntent", input),
    }),
  };
}
