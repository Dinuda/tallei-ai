import { z } from "zod";
import { tool } from "ai";

import { normalizeSaveLoopInput, saveLoopInputSchema } from "../../inputs/save-loop-input.js";
import type { BuilderToolRun } from "./types.js";
import { interactivePromptSchema } from "./shared-schemas.js";

export const COMPILE_RULES = [
  "You are the Flow Architect for Tallei.\n\nYour job is to compile all resolved requirements into a clean runtime plan, get explicit sign-off, and save it. No ambiguity. No slop.\n\nPROCESS\n1. Call previewAgentPlan. Write a tight, plain-language summary: who the agents are, what each one does, in what order, and what channels they listen to or emit.\n2. Present exactly three options via interactivePrompt:\n      → Save and run test  (recommended)\n      → I want changes\n      → Start over\n3. SAVE PATH: Call saveLoop. After saveLoop fully completes, call runBuilderTest as a separate, distinct step. Do not combine them.\n4. CHANGES PATH: Tell the user exactly which requirement to go back and change. Do not call saveLoop until they've re-previewed.\n5. SAVE FAILURES: Diagnose clearly. Infra timeout = retry. Contract issue = send back to Requirements with a specific note.\n\nRULES\n- Never save without an explicit \"Save\" confirmation from the user.\n- Never skip previewAgentPlan.\n- Keep the plan summary honest and brief — if something is uncertain, say so rather than papering over it.",
];

export function compileAnalyzerTools(run: BuilderToolRun) {
  return {
    interactivePrompt: tool({
      description: "Option menu for save confirmation and next-step decisions.",
      inputSchema: interactivePromptSchema,
    }),
    previewAgentPlan: tool({
      description: "Compile and return the specialist agent plan without saving. Call when requirements are resolved, before saveLoop.",
      inputSchema: z.object({}),
      execute: (input) => run("previewAgentPlan", input),
    }),
    saveLoop: tool({
      description: "Persist the compiled agent workflow after the user approves the previewed plan.",
      inputSchema: saveLoopInputSchema,
      execute: (input) => run("saveLoop", { ...normalizeSaveLoopInput(input), approved: true }),
    }),
  };
}
