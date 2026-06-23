import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAgentHandoff } from "../../../src/services/conductor/runtime/spec-run-handoff-eval.js";

const plan = {
  agents: [],
  inputRequirements: [],
  grounding: [],
  externalDataToolkits: [],
  reviewPolicy: null,
  outputReviewGatesMode: "none",
  readTools: [],
  writeTools: [],
  reviewSurfaces: [],
} as const;

const sourceAgent = {
  id: "context",
  index: 0,
  name: "Context Specialist",
  goal: "Gather support-ticket evidence only.",
  guardrails: ["Do not draft outbound replies."],
  doneWhen: ["Evidence is ready."],
  doneCriteria: ["Evidence is ready."],
  failureModes: [],
  toolRefs: ["internal.memory_search"],
  inputContract: { description: "Trigger payload.", schema: {} },
  outputContract: {
    description: "Evidence",
    schema: { type: "object", properties: { status: { type: "string" }, summary: { type: "string" } } },
    representation: "json",
    mediaType: "application/json",
  },
  handoffBindings: [],
  artifactRole: "source_evidence",
  outputArtifactId: "context_output",
  outputArtifactKind: "structured_output",
} as const;

const draftAgent = {
  ...sourceAgent,
  id: "draft",
  index: 1,
  name: "Draft Specialist",
  goal: "Draft the reply.",
  artifactRole: "draft_body",
  handoffBindings: [{
    source: { kind: "agent_output", agentId: "context", path: "/" },
    targetPath: "/",
    required: true,
  }],
} as const;

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    plan,
    agent: sourceAgent,
    nextAgent: draftAgent,
    rawOutput: { status: "ticket_found", summary: "A draft acknowledgment reply already exists in Gmail." },
    structuredOutput: { status: "ticket_found", summary: "A draft acknowledgment reply already exists in Gmail." },
    normalizedOutput: { status: "ticket_found", summary: "A draft acknowledgment reply already exists in Gmail." },
    priorOutputs: [],
    resolvedHandoff: { value: {}, resolvedBindings: [], missingRequired: [] },
    ...overrides,
  };
}

test("evaluateAgentHandoff accepts mocked pass response and normalized handoff", async () => {
  const result = await evaluateAgentHandoff(baseInput(), {
    generateTextImpl: (async () => ({
      text: JSON.stringify({
        status: "pass",
        reason: "Evidence-only output is suitable for the draft agent.",
        blockers: [],
        normalizedOutput: { status: "ticket_found", summary: "A draft acknowledgment reply already exists in Gmail." },
        normalizedHandoff: { ticketStatus: "ticket_found", evidenceSummary: "A draft acknowledgment reply already exists in Gmail." },
      }),
    })) as never,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.normalizedHandoff?.ticketStatus, "ticket_found");
});

test("evaluateAgentHandoff accepts mocked fail response for wrong deliverable ownership", async () => {
  const result = await evaluateAgentHandoff(baseInput({
    rawOutput: { subject: "Re: Help", body: "Thanks for reaching out." },
    structuredOutput: { subject: "Re: Help", body: "Thanks for reaching out." },
    normalizedOutput: { subject: "Re: Help", body: "Thanks for reaching out." },
  }), {
    generateTextImpl: (async () => ({
      text: JSON.stringify({
        status: "fail",
        reason: "The evidence agent produced draft email fields owned by the draft agent.",
        blockers: ["Wrong deliverable ownership"],
        normalizedOutput: { subject: "Re: Help", body: "Thanks for reaching out." },
        normalizedHandoff: {},
      }),
    })) as never,
  });

  assert.equal(result.status, "fail");
  assert.match(result.reason, /draft email fields/i);
});

test("evaluateAgentHandoff passes contract/parser issues to mocked evaluator", async () => {
  const result = await evaluateAgentHandoff(baseInput({
    contractIssues: ["Agent output contract requires JSON, but finalizeAgent output was not valid JSON."],
  }), {
    generateTextImpl: (async () => ({
      text: JSON.stringify({
        status: "retry",
        reason: "The agent must retry with valid JSON.",
        blockers: ["Agent output contract requires JSON, but finalizeAgent output was not valid JSON."],
        normalizedOutput: {},
        normalizedHandoff: {},
      }),
    })) as never,
  });

  assert.equal(result.status, "retry");
  assert.match(result.reason, /valid JSON/i);
});

test("evaluateAgentHandoff returns needs_input for missing required bindings before model call", async () => {
  const result = await evaluateAgentHandoff(baseInput({
    resolvedHandoff: {
      value: {},
      resolvedBindings: [{ targetPath: "/ticket", source: {}, resolved: false, required: true }],
      missingRequired: ["/ticket"],
    },
  }));

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.missingRequired, ["/ticket"]);
});
