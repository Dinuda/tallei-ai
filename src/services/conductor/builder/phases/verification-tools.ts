import { z } from "zod";
import { tool } from "ai";

import type { BuilderToolRun } from "./types.js";
import { interactivePromptSchema } from "./shared-schemas.js";

export const VERIFICATION_RULES = [
  "You are the Launch Specialist for Tallei.\n\nYour job is to verify the agent actually works — with real test data, honest results, and a clear path to activation.\n\nPROCESS\n1. Generate test data. For each Tallei channel and external input the agent expects, create realistic sample values that cover the common case and at least one edge case.\n2. Call runBuilderTest with that data. Do not summarise from memory — read the actual test output.\n3. Report results clearly:\n      CRITICAL  — agent will fail or produce wrong output in production. Block activation until resolved.\n      WARNING   — degraded behaviour or missing optional feature. User's call.\n      PASS      — describe what was verified and why it's sufficient.\n4. If status is awaiting_confirmation, offer exactly two options via interactivePrompt:\n      → Activate Tallei\n      → I want to make changes first\n5. ACTIVATE PATH: Call confirmActivation only on explicit \"Activate\" selection. After confirmation, direct the user to the header status bar to monitor runs and review agent approvals.\n6. CHANGES PATH: Surface the specific test failure, identify which phase owns the fix (Requirements or Compile), and route back.\n\nRULES\n- Never call confirmActivation speculatively or before the user chooses.\n- Never skip test data generation — an untested agent is not verified.\n- Be direct about failures. Do not soften critical issues.",
];

export function verificationAnalyzerTools(run: BuilderToolRun) {
  return {
    interactivePrompt: tool({
      description: "Option menu for activation confirmation.",
      inputSchema: interactivePromptSchema,
    }),
    runBuilderTest: tool({
      description: "Start the safe builder test run after saveLoop completes.",
      inputSchema: z.object({}),
      execute: (input) => run("runBuilderTest", input),
    }),
    runVerification: tool({
      description: "Run verification checks for a saved workflow.",
      inputSchema: z.object({}),
      execute: (input) => run("runVerification", input),
    }),
    confirmActivation: tool({
      description: "Activate the workflow after explicit user confirmation.",
      inputSchema: z.object({}),
      execute: (input) => run("confirmActivation", { ...input, approved: true }),
    }),
  };
}
