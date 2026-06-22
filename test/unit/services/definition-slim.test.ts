import assert from "node:assert/strict";
import test from "node:test";

import {
  slimBuildContractForPersistence,
} from "../../../src/services/loop-engine/build-contract.js";
import {
  expandSlimLoopDefinition,
  isSlimLoopDefinition,
  slimLoopDefinitionForPersistence,
} from "../../../src/services/loop-runtime/definition-slim.js";
import { resolveAgentOutputContract } from "../../../src/services/loop-runtime/agent-contract-catalog.js";
import type { LoopDefinition } from "../../../src/services/loop-executor/types.js";

function fullBuildContract() {
  return {
    version: "v1" as const,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    issues: [],
    requirements: [{
      id: "artifact_contract",
      kind: "artifact_contract" as const,
      question: "Artifact",
      reason: "Needed",
      required: true,
      allowNone: false,
      valueSchema: {},
      status: "resolved" as const,
      value: {
        mode: "supplied_template",
        template: JSON.stringify({
          designId: "support-replies-v1",
          templates: [{ id: "ack", name: "Ack", templateId: "ack", subject: "Hi", html: "<p>Hi</p>" }],
        }),
      },
      validationErrors: [],
      warnings: [],
    }],
  };
}

function fullDefinition(): LoopDefinition {
  const outputContract = resolveAgentOutputContract({
    name: "Context Specialist",
    artifactRole: "source_evidence",
    outputArtifactKind: "structured_output",
  })!;
  return {
    definitionVersion: "loop_executor_v2",
    goal: "Monitor Gmail",
    schedule: { cron: "0 * * * *", timezone: "UTC" },
    ceo: { name: "Orchestrator", task: "Coordinate", policy: "Safe" },
    draftPolicy: {
      requireDraftBeforeExternalAction: true,
      approvalRequiredFor: ["publish", "send", "external_action"],
    },
    deliveryType: "gmail",
    buildContract: fullBuildContract(),
    agentGraph: {
      parent: { id: "orchestrator", name: "Orchestrator", task: "Coordinate", policy: "Safe" },
      children: [{
        id: "context_specialist",
        name: "Context Specialist",
        goal: "Read inbox",
        tools: [{ ref: "composio.gmail.action.GMAIL_FETCH_EMAILS" }],
        guardrails: ["Use only approved read and search tools.", "Do not draft or send outbound messages."],
        doneCriteria: ["Evidence matches the intake output contract."],
        failureModes: ["Pause for operator input when required context is missing."],
        artifactRole: "source_evidence",
        outputArtifactKind: "structured_output",
        outputContract,
        inputContract: { description: "Trigger payload", schema: { type: "object", properties: {}, additionalProperties: true } },
        handoffBindings: [],
        outputArtifactId: "context_specialist_output",
      }],
    },
  };
}

test("slimBuildContractForPersistence drops build-time metadata but keeps artifact templates inline", () => {
  const slim = slimBuildContractForPersistence(fullBuildContract());
  const requirement = slim.requirements[0]!;
  assert.equal("question" in requirement, false);
  const value = requirement.value as Record<string, unknown>;
  assert.equal(value.mode, "supplied_template");
  assert.equal(typeof value.template, "string");
  assert.match(String(value.template), /support-replies-v1/);
});

test("slimLoopDefinitionForPersistence omits ceo, default draft policy, and catalog contracts", () => {
  const slim = slimLoopDefinitionForPersistence(fullDefinition());
  assert.equal(slim.ceo, undefined);
  assert.equal(slim.draftPolicy, undefined);
  assert.equal(slim.agentGraph.children[0]?.outputContract, undefined);
  assert.equal(slim.agentGraph.children[0]?.inputContract, undefined);
  assert.equal(slim.agentGraph.children[0]?.guardrails, undefined);
  assert.ok(isSlimLoopDefinition(slim));
});

test("expandSlimLoopDefinition restores runtime contracts and ceo defaults", () => {
  const slim = slimLoopDefinitionForPersistence(fullDefinition());
  const expanded = expandSlimLoopDefinition(slim);
  assert.ok(expanded.ceo);
  assert.ok(expanded.agentGraph.children[0]?.outputContract);
  assert.ok(expanded.agentGraph.children[0]?.guardrails?.length);
  const hydratedContract = expanded.buildContract?.requirements[0]?.value as Record<string, unknown>;
  assert.equal(typeof hydratedContract.template, "string");
});
