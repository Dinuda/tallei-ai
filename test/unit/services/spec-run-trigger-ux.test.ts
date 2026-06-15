import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const specRunnerPath = new URL("../../../src/services/loop-runtime/spec-runner.ts", import.meta.url);
const creatorPath = new URL("../../../src/services/loop-executor/creator.ts", import.meta.url);
const runPagePath = new URL("../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx", import.meta.url);
const activationCardPath = new URL("../../../dashboard/src/components/loop-activation-card.tsx", import.meta.url);
const developerPagePath = new URL("../../../dashboard/app/dashboard/loops/developer/page.tsx", import.meta.url);
const workflowPagePath = new URL("../../../dashboard/app/dashboard/loops/[workflowId]/page.tsx", import.meta.url);
const loopBuilderRoutePath = new URL("../../../src/transport/http/routes/loopBuilder.ts", import.meta.url);

test("spec runs persist trigger provenance in context and projection", async () => {
  const specRunner = await readFile(specRunnerPath, "utf8");
  assert.match(specRunner, /trigger\?: SpecRunTrigger/);
  assert.match(specRunner, /triggerSource: SpecRunTriggerSource/);
  assert.match(specRunner, /triggerLabel: string \| null/);
  assert.match(specRunner, /trigger: resolvedTrigger/);
});

test("headless spec runs persist full ui message stream", async () => {
  const specRunner = await readFile(specRunnerPath, "utf8");
  assert.match(specRunner, /async function executeSpecRun/);
  assert.match(specRunner, /replaceLoopRunMessages\(input\.auth, input\.runId, completedMessages\)/);
  assert.doesNotMatch(specRunner, /await result\.consumeStream\(\)/);
});

test("workflow list attaches latestRun metadata", async () => {
  const creator = await readFile(creatorPath, "utf8");
  assert.match(creator, /attachWorkflowRunMeta/);
  assert.match(creator, /latestRun: parseLatestRunFromRow/);
});

test("spec run editorial projection exposes steps and artifacts for the run page", async () => {
  const projection = await readFile(
    new URL("../../../src/services/loop-runtime/spec-run-editorial-projection.ts", import.meta.url),
    "utf8",
  );
  const workflows = await readFile(
    new URL("../../../src/transport/http/routes/workflows.ts", import.meta.url),
    "utf8",
  );
  assert.match(projection, /getSpecRunEditorialProjection/);
  assert.match(projection, /workflow_title: specRun\.workflowTitle/);
  assert.match(projection, /steps: \[step\]/);
  assert.match(projection, /artifacts: finalArtifact \? \[finalArtifact\] : \[\]/);
  assert.match(workflows, /getSpecRunEditorialProjection/);
});

test("run page uses the editorial run UI shell", async () => {
  const runPage = await readFile(runPagePath, "utf8");
  assert.match(runPage, /editorial-run-ui|EditorialPanel|OperatorWorkspace/);
});

test("builder activation card opens run page and links back to builder", async () => {
  const [builderPage, activationCard, route] = await Promise.all([
    readFile(new URL("../../../dashboard/app/dashboard/loops/new/page.tsx", import.meta.url), "utf8"),
    readFile(activationCardPath, "utf8"),
    readFile(loopBuilderRoutePath, "utf8"),
  ]);
  assert.match(builderPage, /LoopActivationCard/);
  assert.match(activationCard, /resolveLoopRunNavigation/);
  assert.match(activationCard, /Edit in builder/);
  assert.match(route, /Open loop on the activation card/);
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
