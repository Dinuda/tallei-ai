import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const guardPath = new URL(
  "../../../dashboard/src/lib/spec-run-stream-guard.ts",
  import.meta.url,
);
const specRunPagePath = new URL(
  "../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/components/spec-run-page.tsx",
  import.meta.url,
);

test("spec run stream guard blocks duplicate auto-start and active chat kicks", async () => {
  const [guard, specRunPage] = await Promise.all([
    readFile(guardPath, "utf8"),
    readFile(specRunPagePath, "utf8"),
  ]);
  assert.match(guard, /canKickSpecRunStream/);
  assert.match(guard, /hasSpecRunAutoStartAttempted/);
  assert.match(guard, /markSpecRunAutoStartAttempted/);
  assert.match(specRunPage, /submitInteractionCommand/);
  assert.match(specRunPage, /resumeRunStreamWithRetry/);
  assert.match(specRunPage, /continueInFlightRef/);
  assert.match(specRunPage, /spec-run-stream-guard/);
});
