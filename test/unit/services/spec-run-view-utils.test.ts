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
const artifactRendererPath = new URL(
  "../../../dashboard/src/components/renderers/artifact-renderer.tsx",
  import.meta.url,
);
const canvasRendererRegistryPath = new URL(
  "../../../dashboard/src/components/renderers/canvas-email/index.ts",
  import.meta.url,
);

test("spec run view utils extract structured agent output and review rationale", async () => {
  const source = await readFile(utilsPath, "utf8");
  assert.match(source, /resolveStepDisplayText/);
  assert.match(source, /resolveStepInteractionRationale/);
  assert.match(source, /formatStructuredData/);
  assert.match(source, /formatEmailDrafts/);
  assert.match(source, /resolveDisplayArtifact/);
  assert.match(source, /if \(!canvasKey \|\| !input\.pendingInteraction\) return null/);
  assert.doesNotMatch(source, /hasEmailArtifactContent/);
  assert.doesNotMatch(source, /readArtifactEmailTemplate/);
  assert.match(source, /Connector action completed/);
  assert.match(source, /decision\.output/);
  assert.match(source, /agentOutput/);
  assert.match(source, /priority/);
  assert.match(source, /Saved to your connector/);
});

test("artifact renderer is selected from declared render target before artifact kind", async () => {
  const [renderer, registry] = await Promise.all([
    readFile(artifactRendererPath, "utf8"),
    readFile(canvasRendererRegistryPath, "utf8"),
  ]);

  assert.match(renderer, /artifactRendererKey/);
  assert.match(renderer, /data_json\?\.renderTarget \?\? artifact\.data_json\?\.renderer/);
  assert.match(registry, /kind: "canvas\.email"/);
  assert.match(registry, /kind: "canvas\.preview"/);
});

test("spec run page renders chronological chat transcript via shared renderer", async () => {
  const source = await readFile(specRunPagePath, "utf8");
  assert.match(source, /TranscriptMessageContent/);
  assert.match(source, /dedupeChatMessagesById\(messages\)/);
  assert.match(source, /findActiveToolPart/);
  assert.match(source, /looseTranscriptMessages/);
  assert.match(source, /isLooseTranscriptMessage/);
  assert.match(source, /SearchToolSummary/);
  assert.match(source, /toolName === "searchMemory" \|\| toolName === "searchWeb"/);
  assert.match(source, /continueRunStream/);
  assert.doesNotMatch(source, /transcriptItems\.map/);
  assert.doesNotMatch(source, /EmailDraftCard/);
});
