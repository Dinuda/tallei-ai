import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const specRunnerPath = new URL("../../../src/services/conductor/runtime/spec-runner.ts", import.meta.url);
const creatorPath = new URL("../../../src/services/conductor/services/loop-workflow.service.ts", import.meta.url);
const runPagePath = new URL("../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx", import.meta.url);
const builderHeaderPath = new URL("../../../dashboard/src/components/loop-builder-header.tsx", import.meta.url);
const developerPagePath = new URL("../../../dashboard/app/dashboard/loops/developer/page.tsx", import.meta.url);
const workflowPagePath = new URL("../../../dashboard/app/dashboard/loops/[workflowId]/page.tsx", import.meta.url);
const loopBuilderRoutePath = new URL("../../../src/transport/http/routes/conductor.ts", import.meta.url);

test("spec runs persist trigger provenance in context and projection", async () => {
  const specRunner = await readFile(specRunnerPath, "utf8");
  assert.match(specRunner, /trigger\?: SpecRunTrigger/);
  assert.match(specRunner, /triggerSource: SpecRunTriggerSource/);
  assert.match(specRunner, /triggerLabel: string \| null/);
  assert.match(specRunner, /trigger: resolvedTrigger/);
});

test("headless spec runs execute through the agent orchestrator", async () => {
  const specRunner = await readFile(specRunnerPath, "utf8");
  assert.match(specRunner, /executeAgenticSpecRun/);
  assert.match(specRunner, /triggerSeedMessages/);
  assert.match(specRunner, /existingMessages\.length > 0/);
});

test("workflow list attaches latestRun metadata", async () => {
  const creator = await readFile(creatorPath, "utf8");
  assert.match(creator, /attachWorkflowRunMeta/);
  assert.match(creator, /latestRun: parseLatestRunFromRow/);
});

test("spec run editorial projection exposes steps and artifacts for the run page", async () => {
  const projection = await readFile(
    new URL("../../../src/services/conductor/runtime/spec-run-editorial-projection.ts", import.meta.url),
    "utf8",
  );
  const workflows = await readFile(
    new URL("../../../src/transport/http/routes/workflows.ts", import.meta.url),
    "utf8",
  );
  assert.match(projection, /getSpecRunEditorialProjection/);
  assert.match(projection, /workflow_title: specRun\.workflowTitle/);
  assert.match(projection, /loop_engine_step_attempts/);
  assert.match(projection, /operatorView/);
  assert.match(workflows, /getSpecRunEditorialProjection/);
  assert.match(workflows, /interactions\/:interactionId\/commands/);
});

test("legacy run page uses the editorial run UI shell", async () => {
  const runPage = await readFile(runPagePath, "utf8");
  assert.match(runPage, /editorial-run-ui|EditorialPanel|OperatorWorkspace/);
});

test("spec run page uses builder-style chat transcript with universal renderer", async () => {
  const specRunPage = await readFile(
    new URL("../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(specRunPage, /Conversation/);
  assert.match(specRunPage, /InteractivePromptMenu/);
  assert.match(specRunPage, /TranscriptMessageContent/);
  assert.match(specRunPage, /resolveActiveGate/);
  assert.match(specRunPage, /ArtifactRenderer/);
  assert.match(specRunPage, /isAgentTurnMessage/);
  assert.match(specRunPage, /hydrateMessagesFromSteps/);
  assert.match(specRunPage, /shouldAutoStartRunStream/);
  assert.match(specRunPage, /SpecRunDetailsDialog/);
  assert.match(specRunPage, /View spec/);
  assert.match(specRunPage, /latestAttemptPerStep\(run\.steps\)/);
  assert.match(specRunPage, /Referenced spec/);
  assert.match(specRunPage, /Runner flow/);
  assert.match(specRunPage, /Artifact role:/);
  assert.match(specRunPage, /Renderer:/);
  assert.match(specRunPage, /handoff binding/);
  assert.match(specRunPage, /continueRunStream/);
  assert.match(specRunPage, /interactions\/\$\{interactionId\}\/commands/);
  assert.doesNotMatch(specRunPage, /OperatorWorkspace/);
  assert.doesNotMatch(specRunPage, /ChildAgentRow/);
  assert.doesNotMatch(specRunPage, /SpecRunContinuousThread/);
  assert.doesNotMatch(specRunPage, /EmailDraftCard/);
});

test("spec run gate opens from pending interaction and surfaces produced artifacts", async () => {
  const [specRunPage, utils] = await Promise.all([
    readFile(
      new URL("../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-page.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-view-utils.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(utils, /resolveDisplayArtifact/);
  assert.match(specRunPage, /showGateComposer/);
  assert.match(specRunPage, /ApprovalGatePanel/);
  assert.match(specRunPage, /inlineGateStepId/);
  assert.match(specRunPage, /selectedValue === "approve"/);
  assert.match(specRunPage, /ArtifactRenderer/);
  assert.match(specRunPage, /resolveArtifactForStep/);
  assert.match(specRunPage, /resolveDisplayArtifact/);
  assert.match(specRunPage, /InboundEmailTriggerCard/);
  assert.match(specRunPage, /gate\.show/);
});

test("builder header surfaces run navigation and status outside chat", async () => {
  const [builderPage, header] = await Promise.all([
    readFile(new URL("../../../dashboard/app/dashboard/loops/new/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../dashboard/src/components/loop-builder-header.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(builderPage, /LoopActivationCard/);
  assert.match(header, /Show runs/);
  assert.match(header, /verificationStatus/);
  assert.doesNotMatch(header, /Listening for/);
  assert.match(header, /rounded-none/);
  assert.match(header, /loopRunHref/);
});

test("loop detail and live loops surface trigger run inbox copy", async () => {
  const [workflowPage, developerPage] = await Promise.all([
    readFile(workflowPagePath, "utf8"),
    readFile(developerPagePath, "utf8"),
  ]);
  assert.match(workflowPage, /How runs work/);
  assert.match(workflowPage, /Start manual run/);
  assert.match(workflowPage, /triggerSourceLabel/);
  assert.match(developerPage, /waiting_for_approval/);
  assert.match(developerPage, /triggerSourceLabel/);
});
