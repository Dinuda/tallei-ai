import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerPath = new URL("../../../src/services/loop-runtime/spec-run-agent-runner.ts", import.meta.url);
const toolsPath = new URL("../../../src/services/loop-runtime/spec-run-agent-tools.ts", import.meta.url);
const specRunnerPath = new URL("../../../src/services/loop-runtime/spec-runner.ts", import.meta.url);
const interactionsPath = new URL("../../../src/services/loop-runtime/spec-run-interactions.ts", import.meta.url);
const legacyToolsPath = new URL("../../../src/services/loop-runtime/spec-run-tools.ts", import.meta.url);

test("spec run entry points use the agent orchestrator, streaming writer, and trigger-derived seed context", async () => {
  const source = await readFile(specRunnerPath, "utf8");

  assert.match(source, /executeAgenticSpecRun/);
  assert.match(source, /streamSpecRunChat[\s\S]*executeAgenticSpecRun/);
  assert.match(source, /writer,\s*\n\s*\}\)/);
  assert.match(source, /onFinish: async \(\{ messages: completedMessages \}\)/);
  assert.match(source, /normalizedMessages\.length > 0[\s\S]*existingMessages\.length > 0[\s\S]*triggerSeedMessages/);
  assert.match(source, /if \(existingMessages\.length === 0\)/);
  assert.doesNotMatch(source, /existingMessages\.length === 0 \|\| runContext\.hasTriggerPayload/);
});

test("agent runner materializes spec agents before execution and records tool events on active steps", async () => {
  const [runner, tools] = await Promise.all([
    readFile(runnerPath, "utf8"),
    readFile(toolsPath, "utf8"),
  ]);

  assert.match(runner, /compileSpecRunPlan/);
  assert.match(runner, /ensureAgentSteps/);
  assert.match(runner, /export async function materializeSpecRunAgentSteps/);
  assert.match(runner, /agent_started/);
  assert.match(runner, /streamText/);
  assert.match(runner, /writer\.merge\(agentStream\.toUIMessageStream/);
  assert.match(runner, /type: "data-agent"/);
  assert.match(runner, /persona/);
  assert.match(runner, /phase: "working"/);
  assert.match(runner, /NEVER call requestInput for searchMemory queries/);
  assert.match(tools, /tool_spawned/);
  assert.match(tools, /stepAttemptId: input\.stepAttemptId/);
  assert.doesNotMatch(runner, /buildTrackedSpecRunTools/);
});

test("run creation and retry materialize approved agents before async execution starts", async () => {
  const source = await readFile(specRunnerPath, "utf8");

  assert.match(source, /materializeSpecRunAgentSteps/);
  assert.match(source, /createSpecLoopRun[\s\S]*await materializeSpecRunAgentSteps\(\{ auth, runId, spec \}\)/);
  assert.match(source, /retrySpecLoopRun[\s\S]*await materializeSpecRunAgentSteps\(\{\s*auth: hydratedAuth,\s*runId,\s*spec: projection\.runnableSpec,/);
  assert.match(source, /await materializeSpecRunAgentSteps[\s\S]*await startLoopRunWorkflow/);
});

test("mutating connector actions are gated through requestApproval interactions", async () => {
  const source = await readFile(toolsPath, "utf8");

  assert.match(source, /tools\.requestApproval = tool/);
  assert.match(source, /selectedWriteTool\(input\.plan, actionRef, input\.agent\)/);
  assert.match(source, /approvalGrantCoversAction/);
  assert.match(source, /createSpecRunApprovalInteraction/);
  assert.match(source, /idempotencyKey: `spec-run:\$\{input\.runId\}:\$\{input\.stepAttemptId\}:\$\{writeTool\.toolKey\}`/);
  assert.doesNotMatch(source, /for \(const writeTool of input\.plan\.writeTools\)[\s\S]*tools\[writeTool\.toolKey\]/);
});

test("operator decisions resume, revise, or reject through engine state", async () => {
  const source = await readFile(interactionsPath, "utf8");

  assert.match(source, /input\.command === "submit_input"/);
  assert.match(source, /input\.command === "revise"/);
  assert.match(source, /invalidated_at = NOW\(\)/);
  assert.match(source, /status = 'queued'/);
  assert.match(source, /executeDeferredWriteTool/);
  assert.match(source, /storeSpecRunApprovalGrant/);
  assert.match(source, /const storeApprovalGrant = async \(authorizedActionRefs: string\[\]\)/);
  assert.match(source, /await storeApprovalGrant\(deferredActionRefs\(\)\)/);
  assert.doesNotMatch(source, /authorizedActionRefsForWriteTools\(plan\.writeTools\)/);
  assert.match(source, /enqueueLoopRunCommand/);
  assert.match(source, /resumeRunAfterApproval/);
  assert.match(source, /finalizeInteractionResume/);
  assert.match(source, /shouldResumeViaStream/);
});

test("legacy direct connector write tools fail closed without the approval wrapper", async () => {
  const source = await readFile(legacyToolsPath, "utf8");

  assert.match(source, /if \(write\) \{\s*throw new Error\(`Action \$\{actionSlug\} requires operator approval before execution\.`\);/);
  assert.match(source, /deferredWrites\[toolKey\]/);
});
