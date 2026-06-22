import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { suppressAgentTextChunks } from "../../../src/services/loop-runtime/spec-run-agent-runner.js";

const runnerPath = new URL("../../../src/services/loop-runtime/spec-run-agent-runner.ts", import.meta.url);
const toolsPath = new URL("../../../src/services/loop-runtime/spec-run-agent-tools.ts", import.meta.url);
const specRunnerPath = new URL("../../../src/services/loop-runtime/spec-runner.ts", import.meta.url);
const interactionsPath = new URL("../../../src/services/loop-runtime/spec-run-interactions.ts", import.meta.url);

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
  assert.match(runner, /hasToolCall/);
  assert.match(runner, /hasToolCall\("finalizeAgent"\)/);
  assert.match(runner, /hasToolCall\("finalizeRun"\)/);
  assert.match(runner, /writer\.merge\(suppressAgentTextChunks\(agentStream\.toUIMessageStream/);
  assert.match(runner, /type: "data-agent"/);
  assert.match(runner, /persona/);
  assert.match(runner, /phase: "working"/);
  assert.match(runner, /availableToolNames: Object\.keys\(tools\)/);
  assert.match(runner, /resolvedHandoff/);
  assert.match(runner, /validateContractData/);
  assert.match(runner, /evaluateAgentHandoff/);
  assert.match(runner, /buildBoundaryEnvelope/);
  assert.match(runner, /normalizedHandoffFromStepOutput/);
  assert.match(runner, /handoff_evaluated/);
  assert.match(runner, /requeueAgentStepRetry/);
  assert.match(runner, /createMissingHandoffInputIfPossible/);
  assert.match(runner, /reconcileStaleRunningSteps/);
  assert.match(runner, /reconcilePendingInteractionSteps/);
  assert.match(runner, /isReasoningStreamChunk/);
  assert.match(runner, /createConfiguredGateIfNeeded/);
  assert.match(runner, /Spec-defined gates are authoritative/);
  assert.match(runner, /isNoActionRequiredOutput/);
  assert.match(runner, /if \(isNoActionRequiredOutput\(input\.structuredOutput\)\) return false/);
  assert.match(runner, /shouldTerminateRunAfterAgent/);
  assert.match(runner, /configuredAgentGateRequired/);
  assert.doesNotMatch(runner, /outputReviewGatesMode/);
  assert.match(runner, /persistAgentOutputArtifact/);
  assert.match(runner, /structuredOutput/);
  assert.match(runner, /authorization identifiers, not callable tool names/);
  assert.match(runner, /This agent has no write actionRefs/);
  assert.match(runner, /do not create labels, drafts, replies, sends, or any other Gmail mutations/);
  assert.match(runner, /action_\* tools enforce the declared Composio input schema via Zod/);
  assert.match(runner, /NEVER call requestInput for searchMemory queries/);
  assert.match(runner, /Never write that a review was submitted, approval is pending, or the run is paused/);
  assert.match(runner, /Stop after finalizeAgent/);
  assert.match(runner, /MUST include summary and status/);
  assert.match(runner, /Do not produce draft\/subject\/body\/html\/message\/reply\/emailTemplate fields/);
  assert.match(runner, /suppressAgentTextChunks\(agentStream\.toUIMessageStream/);
  assert.match(runner, /no_tickets_found/);
  assert.doesNotMatch(runner, /assertSourceEvidenceDoesNotDraft/);
  assert.doesNotMatch(runner, /assertNoFakeOperatorGate/);
  assert.doesNotMatch(runner, /claimsOperatorGateWithoutInteraction/);
  assert.doesNotMatch(runner, /Allowed direct tools \(call without any gate\): searchMemory, searchWeb/);
  assert.match(tools, /tool_spawned/);
  assert.match(tools, /stepAttemptId: input\.stepAttemptId/);
  assert.match(tools, /agentWriteTools/);
  assert.match(tools, /agentCanRequestInput/);
  assert.match(tools, /if \(agentCanRequestInput\(input\.plan, input\.agent\)\)/);
  assert.match(tools, /if \(writeToolsForAgent\.length > 0 && !input\.agent\.gate\)/);
  assert.match(tools, /buildConnectorToolInputSchema/);
  assert.match(tools, /connectorToolDescription/);
  assert.match(tools, /extractConnectorActionPayload/);
  assert.match(tools, /prepareConnectorActionPayload/);
  assert.match(tools, /superRefine/);
  assert.match(tools, /resolvedHandoff/);
  assert.match(tools, /isRedundantTriggerReadTool/);
  assert.match(tools, /const searchCache = new Map<string, unknown>\(\)/);
  assert.match(tools, /cachedSearch\(`memory:\$\{query\.trim\(\)\.toLowerCase\(\)\}`/);
  assert.match(tools, /if \(writeToolsForAgent\.length > 0\)/);
  assert.doesNotMatch(tools, /tools\.finalizeRun = tool/);
  assert.match(tools, /GMAIL_FETCH_MESSAGE_BY_THREAD_ID/);
  assert.doesNotMatch(runner, /buildTrackedSpecRunTools/);
});

test("agent UI stream suppresses freeform text chunks", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "data-agent", data: { stepIndex: 1, agentId: "draft" } });
      controller.enqueue({ type: "text-start", id: "txt-1" });
      controller.enqueue({ type: "text-delta", id: "txt-1", delta: "Leaked draft" });
      controller.enqueue({ type: "text-end", id: "txt-1" });
      controller.enqueue({
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "finalizeAgent",
        input: { output: { status: "draft_ready" } },
      });
      controller.close();
    },
  });

  const chunks: Array<{ type: string }> = [];
  for await (const chunk of suppressAgentTextChunks(source as Parameters<typeof suppressAgentTextChunks>[0])) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks.map((chunk) => chunk.type), ["data-agent", "tool-input-available"]);
});

test("run creation and retry materialize approved agents before async execution starts", async () => {
  const source = await readFile(specRunnerPath, "utf8");

  assert.match(source, /materializeSpecRunAgentSteps/);
  assert.match(source, /createSpecLoopRun[\s\S]*await materializeSpecRunAgentSteps\(\{ auth, runId, spec, workflowId \}\)/);
  assert.match(source, /retrySpecLoopRun[\s\S]*await materializeSpecRunAgentSteps\(\{\s*auth: hydratedAuth,\s*runId,\s*spec: projection\.loopDefinition,/);
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
  assert.doesNotMatch(source, /tryAutoExecuteDraftAfterReviewApproval/);
  assert.match(source, /enqueueLoopRunCommand/);
  assert.match(source, /resumeRunAfterApproval/);
  assert.match(source, /finalizeInteractionResume/);
  assert.match(source, /shouldResumeViaStream/);
  assert.match(source, /patchMessagesWithToolResult\(messages, "requestApproval", output\)/);
  assert.match(source, /patchMessagesWithToolResult\(patchedApproval, toolKey, output\)/);
});
