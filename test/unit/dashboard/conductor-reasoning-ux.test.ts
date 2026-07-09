import assert from "node:assert/strict";
import test from "node:test";

import { buildHiddenToolSummaryViewModel } from "../../../dashboard/src/components/conductor/conductor-hidden-tool-summary-view-model";
import { sanitizeConductorReasoningForDisplay } from "../../../dashboard/src/lib/conductor-reasoning-sanitize";

test("sanitizeConductorReasoningForDisplay replaces internal tool names", () => {
  const sanitized = sanitizeConductorReasoningForDisplay(
    "analyzeIntent must set approval mode before resolveBindings runs.",
  );
  assert.doesNotMatch(sanitized, /analyzeIntent|resolveBindings/);
  assert.match(sanitized, /intent analysis/);
  assert.match(sanitized, /workflow action setup/);
});

test("buildHiddenToolSummaryViewModel summarizes analyzeIntent without tool names", () => {
  const viewModel = buildHiddenToolSummaryViewModel("analyzeIntent", {
    ok: true,
    analysis: {
      outcome: "Summarize new support tickets",
      trigger: "a ticket is created",
      executionOrder: [],
      questions: [],
    },
  }, "output-available");

  assert.equal(viewModel?.title, "Captured the workflow intent");
  assert.match(viewModel?.subtitle ?? "", /Summarize new support tickets/);
  assert.doesNotMatch(viewModel?.subtitle ?? "", /analyzeIntent/);
});

test("buildHiddenToolSummaryViewModel summarizes discoverBindings in user terms", () => {
  const viewModel = buildHiddenToolSummaryViewModel("discoverBindings", {
    ok: true,
    suggestedBindings: [{ outcomeId: "o1" }, { outcomeId: "o2" }],
  }, "output-available");

  assert.equal(viewModel?.title, "Checked available actions");
  assert.doesNotMatch(viewModel?.subtitle ?? "", /slug|json|discoverBindings/i);
});

test("buildHiddenToolSummaryViewModel hides listTriggers outputs", () => {
  const viewModel = buildHiddenToolSummaryViewModel("listTriggers", {
    toolkit: "gmail",
    triggers: [{ slug: "GMAIL_NEW_EMAIL", name: "New email" }],
  }, "output-available");

  assert.equal(viewModel, null);
});

test("conductor reasoning part opens latest streaming thought and truncates long bodies", async () => {
  const fs = await import("node:fs/promises");
  const reasoningPart = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-reasoning-part.tsx", import.meta.url),
    "utf8",
  );
  const builderChat = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-builder-chat.tsx", import.meta.url),
    "utf8",
  );

  assert.match(reasoningPart, /pauseForUserInput/);
  assert.match(reasoningPart, /displayStreaming/);
  assert.match(builderChat, /pauseReasoningForUserInput/);
});

test("internal workflow tools are hidden from the transcript", async () => {
  const fs = await import("node:fs/promises");
  const toolPart = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url),
    "utf8",
  );

  assert.match(toolPart, /INTERNAL_TRANSCRIPT_TOOLS/);
  assert.match(toolPart, /INTERNAL_TRANSCRIPT_TOOLS\.has\(toolName\)/);
  assert.match(toolPart, /return null;/);
  assert.doesNotMatch(toolPart, /MemoizedHiddenToolSummary/);
  assert.doesNotMatch(toolPart, /HiddenToolSummaryCard/);
  assert.match(toolPart, /export const ConductorToolPart = memo/);
  assert.doesNotMatch(toolPart, /sanitizeConductorReasoningForDisplay/);
});

test("planning prompt requires user-facing sentence after internal reasoning", async () => {
  const fs = await import("node:fs/promises");
  const planningAgent = await fs.readFile(
    new URL("../../../src/loops/planning-agent.ts", import.meta.url),
    "utf8",
  );

  assert.match(planningAgent, /After internal reasoning, write one concise user-facing sentence/);
  assert.match(planningAgent, /never mention internal tool names/);
});
