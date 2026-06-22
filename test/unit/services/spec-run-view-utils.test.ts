import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const utilsPath = new URL(
  "../../../dashboard/src/lib/spec-run-step-artifacts.ts",
  import.meta.url,
);
const specRunViewUtilsPath = new URL(
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
const runToolRowPath = new URL(
  "../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/run-tool-row.tsx",
  import.meta.url,
);

test("spec run view utils extract structured agent output and review rationale", async () => {
  const [source, viewUtils] = await Promise.all([
    readFile(utilsPath, "utf8"),
    readFile(specRunViewUtilsPath, "utf8"),
  ]);
  assert.match(viewUtils, /resolveStepDisplayText/);
  assert.match(viewUtils, /resolveStepInteractionRationale/);
  assert.match(viewUtils, /formatStructuredData/);
  assert.match(viewUtils, /formatEmailDrafts/);
  assert.match(viewUtils, /resolveDisplayArtifact/);
  assert.match(viewUtils, /collapseValidationError/);
  assert.match(viewUtils, /if \(!input\.pendingInteraction\)/);
  assert.doesNotMatch(viewUtils, /hasEmailArtifactContent/);
  assert.doesNotMatch(viewUtils, /readArtifactEmailTemplate/);
  assert.match(viewUtils, /isRunMetaNarration/);
  assert.match(viewUtils, /workflow run summary/);
  assert.match(viewUtils, /all \(three \)\?agents have completed/);
  assert.match(viewUtils, /proceeding to \.\*specialist/);
  assert.match(viewUtils, /\^i\['’\]ll start by/);
  assert.match(viewUtils, /\[a-z\\s\]\+specialist complete/);
  assert.match(viewUtils, /let me now finalize/);
  assert.match(viewUtils, /isGateComposerReady/);
  assert.match(viewUtils, /Connector action completed/);
  assert.match(viewUtils, /decision\.output/);
  assert.match(viewUtils, /agentOutput/);
  assert.match(viewUtils, /priority/);
  assert.match(viewUtils, /Saved to your connector/);
  assert.match(viewUtils, /extractPriorOutputGroups/);
  assert.match(viewUtils, /extractOutputFields/);
  assert.match(viewUtils, /resolveHandoffTargets/);
});

test("spec run step artifact helpers resolve canvas email artifacts per step", async () => {
  const source = await readFile(utilsPath, "utf8");
  assert.match(source, /resolveStepOutputArtifact/);
  assert.match(source, /isArtifactSummaryNarration/);
  assert.match(source, /isRenderableOutputArtifact/);
  assert.match(source, /canvas_email/);
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
  const [source, runToolRow] = await Promise.all([
    readFile(specRunPagePath, "utf8"),
    readFile(runToolRowPath, "utf8"),
  ]);
  assert.match(source, /TranscriptMessageContent/);
  assert.match(source, /dedupeChatMessagesById\(messages\)/);
  assert.match(source, /isRunMetaNarration/);
  assert.match(source, /isLooseTranscriptMessage/);
  assert.match(source, /liveAgentMessageId/);
  assert.match(source, /RunToolRow/);
  assert.match(source, /isCompactRunTool/);
  assert.match(source, /resolveArtifactForStep/);
  assert.match(source, /@\/lib\/spec-run-step-artifacts/);
  assert.match(source, /ArtifactRenderer/);
  assert.match(source, /ScrollOnStepComplete/);
  assert.match(source, /shouldRenderLiveStepText/);
  assert.match(source, /\^re:\\s\*\.\+\\n\+hi\\s\+/);
  assert.match(source, /best regards,\\s\*the support team/);
  assert.match(source, /isStreaming=\{isLive\}/);
  assert.match(source, /gate\.operatorView/);
  assert.match(source, /buildGatePromptOptions/);
  assert.match(source, /showGateComposer/);
  assert.match(source, /TranscriptMessageContent/);
  assert.match(source, /HandoffInputPanel/);
  assert.match(source, /HandoffOutputPanel/);
  assert.match(source, /extractPriorOutputGroups/);
  assert.match(source, /resolveHandoffTargets/);
  assert.doesNotMatch(source, /buildSequentialStepTranscript/);
  assert.doesNotMatch(source, /stepTranscript/);
  assert.doesNotMatch(source, /showWorking/);
  assert.doesNotMatch(source, /Working…/);
  assert.doesNotMatch(source, /ScrollOnUpdate/);
  assert.doesNotMatch(source, /transition-\[padding-bottom\]/);
  assert.doesNotMatch(source, /transcriptItems\.map/);
  assert.doesNotMatch(source, /EmailDraftCard/);
  assert.doesNotMatch(runToolRow, /Running…/);
  assert.doesNotMatch(runToolRow, /Loader2/);
});
