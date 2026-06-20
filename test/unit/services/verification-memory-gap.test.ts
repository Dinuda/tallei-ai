import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const resolveAuthPath = new URL("../../../src/services/loop-runtime/resolve-loop-run-auth.ts", import.meta.url);
const verificationScopePath = new URL("../../../src/services/loop-executor/verification-scope.ts", import.meta.url);
const verificationPath = new URL("../../../src/services/loop-executor/verification.ts", import.meta.url);
const composioTriggerPath = new URL("../../../src/services/loop-runtime/composio-trigger.ts", import.meta.url);
const specSchedulerPath = new URL("../../../src/services/loop-runtime/spec-scheduler.ts", import.meta.url);
const specRunnerPath = new URL("../../../src/services/loop-runtime/spec-runner.ts", import.meta.url);

test("resolveLoopRunAuth loads workflow workspace into auth", async () => {
  const source = await readFile(resolveAuthPath, "utf8");
  assert.match(source, /export async function resolveLoopRunAuth/);
  assert.match(source, /loadWorkflowWorkspaceId/);
  assert.match(source, /SELECT workspace_id/);
});

test("triggered spec runs hydrate workspace auth", async () => {
  const [composioTrigger, specScheduler, specRunner] = await Promise.all([
    readFile(composioTriggerPath, "utf8"),
    readFile(specSchedulerPath, "utf8"),
    readFile(specRunnerPath, "utf8"),
  ]);
  assert.match(composioTrigger, /resolveLoopRunAuth/);
  assert.match(specScheduler, /resolveLoopRunAuth/);
  assert.match(specRunner, /loadWorkflowWorkspaceId/);
  assert.match(specRunner, /withWorkflowWorkspaceAuth/);
});

test("verification adds grounding probes and runtime transparency notes", async () => {
  const [scope, verification] = await Promise.all([
    readFile(verificationScopePath, "utf8"),
    readFile(verificationPath, "utf8"),
  ]);
  assert.match(scope, /deriveGroundingVerificationTargets/);
  assert.match(scope, /grounding_probe/);
  assert.match(scope, /VERIFICATION_RUNTIME_TRANSPARENCY_NOTES/);
  assert.match(verification, /deriveGroundingVerificationTargets\(buildContract\)/);
  assert.match(verification, /probeKind === "grounding_probe"/);
  assert.match(verification, /loadWorkflowWorkspaceId/);
  assert.match(verification, /VERIFICATION_RUNTIME_TRANSPARENCY_NOTES/);
  assert.match(verification, /no workspace is assigned to this workflow/);
});

test("spec run retry endpoint and run page retry controls", async () => {
  const [workflows, specRunner, runPage] = await Promise.all([
    readFile(new URL("../../../src/transport/http/routes/workflows.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../src/services/loop-runtime/spec-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../dashboard/app/dashboard/loops/[workflowId]/runs/[runId]/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(specRunner, /export async function retrySpecLoopRun/);
  assert.match(workflows, /router\.post\("\/runs\/:runId\/retry"/);
  assert.match(workflows, /retrySpecLoopRun/);
  assert.match(runPage, /retryRun/);
  assert.match(runPage, /RotateCcw/);
  assert.match(runPage, /isSpecDrivenRun/);
});
