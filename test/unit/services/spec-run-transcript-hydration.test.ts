import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hydrationPath = new URL(
  "../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-transcript-hydration.ts",
  import.meta.url,
);
const utilsPath = new URL(
  "../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-view-utils.ts",
  import.meta.url,
);
const specRunPagePath = new URL(
  "../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-page.tsx",
  import.meta.url,
);
const projectionPath = new URL(
  "../../../src/services/loop-runtime/spec-run-editorial-projection.ts",
  import.meta.url,
);

test("agent turns merge streamed chat messages with persisted step synthesis", async () => {
  const [hydration, specRunPage] = await Promise.all([
    readFile(hydrationPath, "utf8"),
    readFile(specRunPagePath, "utf8"),
  ]);
  assert.match(hydration, /normalizeTranscriptMessages/);
  assert.match(hydration, /syntheticAgentMessageForStep/);
  assert.match(hydration, /syntheticAgentMessageForPlan/);
  assert.match(hydration, /plannedAgents: PlannedSpecAgent\[\]/);
  assert.match(hydration, /totalAgents = Math\.max\(plannedAgents\.length/);
  assert.doesNotMatch(specRunPage, /isDraftReviewInteraction/);
  assert.match(hydration, /extractStreamPartsByStepIndex/);
  assert.match(hydration, /readAgentStepIndex/);
  assert.match(hydration, /isAgentTurnMessage/);
  assert.match(hydration, /mergeStreamPartsForStep/);
  assert.match(hydration, /mergeToolPartIntoParts/);
  assert.match(hydration, /mergeTextPart/);
  assert.match(hydration, /pickPreferredReasoningPart/);
  assert.doesNotMatch(hydration, /buildSequentialStepTranscript/);
  assert.doesNotMatch(hydration, /buildHeaderPart/);
  assert.doesNotMatch(hydration, /hydratedBodyForStep/);
  assert.doesNotMatch(hydration, /compactCompletedStreamBody/);
  assert.match(hydration, /synthetic-agent-turn/);
  assert.match(specRunPage, /isAgentTurnMessage/);
  assert.match(specRunPage, /readAgentStepIndex/);
  assert.match(specRunPage, /liveAgentMessageId/);
  assert.match(specRunPage, /run\.definition\?\.agentGraph\?\.children \?\? \[\]/);
  assert.match(specRunPage, /kickRunStream/);
  assert.match(specRunPage, /spec-run-stream-guard/);
  assert.doesNotMatch(specRunPage, /buildSequentialStepTranscript/);
  assert.doesNotMatch(specRunPage, /stepTranscript\.map/);
});

test("step display resolves handoff and finalize agent outputs", async () => {
  const utils = await readFile(utilsPath, "utf8");
  assert.match(utils, /selectBestStepAttempt/);
  assert.match(utils, /resolvePriorAgentHandoff/);
  assert.match(utils, /priorOutputs/);
  assert.match(utils, /resolveFinalizeAgent/);
  assert.match(utils, /formatClassifiedEmails/);
  assert.match(utils, /data\.emails/);
  assert.match(utils, /collapseValidationError/);
  assert.match(utils, /if \(!input\.pendingInteraction\)/);
});

test("editorial projection parses structured JSON stored in step text", async () => {
  const projection = await readFile(projectionPath, "utf8");
  assert.match(projection, /JSON\.parse\(rawText\)/);
  assert.match(projection, /input_json: asRecord\(row\.input_json\)/);
});

test("agent turn rendering lets artifacts own draft output", async () => {
  const specRunPage = await readFile(specRunPagePath, "utf8");

  assert.match(specRunPage, /const persistedStepArtifact = resolveArtifactForStep/);
  assert.match(specRunPage, /const syntheticStepArtifact = persistedStepArtifact \? null : buildRenderedStepArtifact/);
  assert.match(specRunPage, /const hideArtifactSummary = showArtifact/);
  assert.match(specRunPage, /if \(showArtifact\) return false/);
  assert.match(specRunPage, /\^re:\\s\*\.\+\\n\+hi\\s\+/);
  assert.match(specRunPage, /best regards,\\s\*the support team/);
});

test("agent turn rendering surfaces failed step errors", async () => {
  const specRunPage = await readFile(specRunPagePath, "utf8");

  assert.match(specRunPage, /const failureMessage = resolveStepFailureMessage/);
  assert.match(specRunPage, /<span className="font-medium text-\[#374151\]">Error: <\/span>/);
  assert.match(specRunPage, /void refreshMessages\(true\)/);
  assert.match(specRunPage, /Loading approval controls/);
  assert.match(specRunPage, /const inlineGateStepId = gate\.show && !submittedAnswer && !noActionReview/);
  assert.match(specRunPage, /operatorView: OperatorView \| null/);
});
