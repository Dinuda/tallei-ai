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

test("agent turns are built from persisted steps instead of chat-only hydration", async () => {
  const [hydration, specRunPage] = await Promise.all([
    readFile(hydrationPath, "utf8"),
    readFile(specRunPagePath, "utf8"),
  ]);
  assert.match(hydration, /buildSequentialStepTranscript/);
  assert.match(hydration, /buildAgentTurnMessagesFromSteps/);
  assert.match(hydration, /extractStreamPartsByStepIndex/);
  assert.match(hydration, /buildHeaderPart/);
  assert.match(hydration, /bodyHasContent/);
  assert.match(hydration, /toolParts/);
  assert.match(hydration, /hasFinalizeOutput/);
  assert.match(hydration, /showArtifact/);
  assert.match(specRunPage, /buildSequentialStepTranscript/);
  assert.match(specRunPage, /stepTranscript\.map/);
});

test("step display resolves handoff and finalize agent outputs", async () => {
  const utils = await readFile(utilsPath, "utf8");
  assert.match(utils, /selectBestStepAttempt/);
  assert.match(utils, /resolvePriorAgentHandoff/);
  assert.match(utils, /priorOutputs/);
  assert.match(utils, /resolveFinalizeAgent/);
});

test("editorial projection parses structured JSON stored in step text", async () => {
  const projection = await readFile(projectionPath, "utf8");
  assert.match(projection, /JSON\.parse\(rawText\)/);
  assert.match(projection, /input_json: asRecord\(row\.input_json\)/);
});
