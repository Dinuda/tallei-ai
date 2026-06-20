import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const utilsPath = new URL(
  "../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-view-utils.ts",
  import.meta.url,
);
const specRunPagePath = new URL(
  "../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-page.tsx",
  import.meta.url,
);

test("spec run view utils extract structured agent output and review rationale", async () => {
  const source = await readFile(utilsPath, "utf8");
  assert.match(source, /resolveStepDisplayText/);
  assert.match(source, /resolveStepInteractionRationale/);
  assert.match(source, /formatStructuredData/);
  assert.match(source, /formatEmailDrafts/);
  assert.match(source, /resolveDisplayArtifact/);
  assert.match(source, /agentOutput/);
  assert.match(source, /priority/);
  assert.match(source, /Saved to your connector/);
});

test("spec run page renders chronological chat transcript via shared renderer", async () => {
  const source = await readFile(specRunPagePath, "utf8");
  assert.match(source, /TranscriptMessageContent/);
  assert.match(source, /dedupeChatMessagesById\(messages\)/);
  assert.match(source, /findActiveToolPart/);
  assert.match(source, /continueRunStream/);
  assert.doesNotMatch(source, /transcriptItems\.map/);
  assert.doesNotMatch(source, /EmailDraftCard/);
});
