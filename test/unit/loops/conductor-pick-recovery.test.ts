import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import {
  commitBuildArtifact,
  createBuildState,
  loopBuildStateSchema,
  type LoopBuildState,
} from "../../../src/loops/build-state.js";
import { recoverMissingPickConnectorApp } from "../../../src/loops/conductor-pick-recovery.js";

function connectorBlueprintState(outcomes: Array<{
  id: string;
  role: "trigger" | "source" | "destination" | "transform";
  description: string;
}>): LoopBuildState {
  const intent = commitBuildArtifact({
    state: createBuildState(),
    phase: "intent",
    artifact: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      intent: { goal: "Handle support tickets", outcome: "Reply sent", successCriteria: [] },
      startCondition: "A support ticket arrives",
      sourceHints: [],
    },
  });
  const blueprint = commitBuildArtifact({
    state: intent.state,
    phase: "blueprint",
    expectedParentHash: intent.envelope.artifactHash,
    artifact: {
      taskBlueprint: {
        version: 1,
        summary: "Support",
        outcomes: outcomes.map((outcome) => ({
          id: outcome.id,
          role: outcome.role,
          description: outcome.description,
          status: "pending",
        })),
      },
      agent: { instructions: "Handle support", maxSteps: 12, maxTokens: 8000 },
      approval: {},
      guardrails: {},
    },
  });
  return loopBuildStateSchema.parse({ ...blueprint.state, buildPhase: "connectors" });
}

function discoveryMessage(groups: Array<{
  outcomeId: string;
  role: string;
  askOptions: Array<{ id: string; label: string; value: string }>;
}>): UIMessage {
  return {
    id: "assistant-discovery",
    role: "assistant",
    parts: [{
      type: "tool-discoverConnectorsForBlueprint",
      toolCallId: "discover-1",
      state: "output-available",
      input: {},
      output: {
        groups,
        autoResolved: [],
        pickerKind: "app",
      },
    }],
  };
}

test("recoverMissingPickConnectorApp injects picker for next pending outcome", () => {
  const state = connectorBlueprintState([
    { id: "step-1", role: "trigger", description: "wait for a new support ticket to arrive" },
    { id: "step-5", role: "destination", description: "send the reply" },
  ]);
  const messages: UIMessage[] = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Help with support tickets" }],
    },
    discoveryMessage([
      {
        outcomeId: "step-1",
        role: "trigger",
        askOptions: [
          { id: "gmail", label: "Gmail", value: "gmail" },
          { id: "outlook", label: "Outlook", value: "outlook" },
        ],
      },
      {
        outcomeId: "step-5",
        role: "destination",
        askOptions: [
          { id: "gmail", label: "Gmail", value: "gmail" },
          { id: "zendesk", label: "Zendesk", value: "zendesk" },
        ],
      },
    ]),
    {
      id: "assistant-stall",
      role: "assistant",
      parts: [{
        type: "reasoning",
        text: "The user needs to choose apps for step-1 and step-5. Let me present the options using pickConnectorApp.",
        state: "done",
      }],
    },
  ];

  const recovered = recoverMissingPickConnectorApp({
    messages,
    state,
    pendingUiTool: null,
    nextTool: "pickConnectorApp",
    phase: "connectors",
  });

  assert.equal(recovered.injected, true);
  assert.equal(recovered.outcomeId, "step-1");
  const last = recovered.messages.at(-1);
  assert.equal(last?.role, "assistant");
  const pick = (last?.parts ?? []).find((part) => part.type === "tool-pickConnectorApp") as {
    toolCallId?: string;
    state?: string;
    input?: { outcomeId?: string; role?: string };
  } | undefined;
  assert.ok(pick);
  assert.equal(pick.state, "input-available");
  assert.equal(pick.input?.outcomeId, "step-1");
  assert.equal(pick.input?.role, "trigger");
  assert.equal(pick.toolCallId, recovered.toolCallId);
});

test("recoverMissingPickConnectorApp skips already-selected outcomes", () => {
  const state = connectorBlueprintState([
    { id: "step-1", role: "trigger", description: "wait for a new support ticket to arrive" },
    { id: "step-5", role: "destination", description: "send the reply" },
  ]);
  const messages: UIMessage[] = [
    discoveryMessage([
      {
        outcomeId: "step-1",
        role: "trigger",
        askOptions: [
          { id: "gmail", label: "Gmail", value: "gmail" },
          { id: "outlook", label: "Outlook", value: "outlook" },
        ],
      },
      {
        outcomeId: "step-5",
        role: "destination",
        askOptions: [
          { id: "gmail", label: "Gmail", value: "gmail" },
          { id: "zendesk", label: "Zendesk", value: "zendesk" },
        ],
      },
    ]),
    {
      id: "assistant-pick",
      role: "assistant",
      parts: [{
        type: "tool-pickConnectorApp",
        toolCallId: "pick-1",
        state: "output-available",
        input: { outcomeId: "step-1", role: "trigger" },
        output: {
          questionId: "connector-app:step-1",
          answerText: "Gmail",
          selectedOptionIds: ["gmail"],
          selectedValues: ["gmail"],
          outcomeId: "step-1",
          role: "trigger",
        },
      }],
    },
    {
      id: "assistant-stall",
      role: "assistant",
      parts: [{
        type: "reasoning",
        text: "Now present destination options one at a time.",
        state: "done",
      }],
    },
  ];

  const recovered = recoverMissingPickConnectorApp({
    messages,
    state,
    pendingUiTool: null,
    nextTool: "pickConnectorApp",
    phase: "connectors",
  });

  assert.equal(recovered.injected, true);
  assert.equal(recovered.outcomeId, "step-5");
  const pick = (recovered.messages.at(-1)?.parts ?? []).find((part) => part.type === "tool-pickConnectorApp") as {
    input?: { outcomeId?: string; role?: string };
  } | undefined;
  assert.equal(pick?.input?.outcomeId, "step-5");
  assert.equal(pick?.input?.role, "destination");
});

test("recoverMissingPickConnectorApp is a no-op when a picker is already open", () => {
  const state = connectorBlueprintState([
    { id: "step-1", role: "trigger", description: "wait for a new support ticket to arrive" },
  ]);
  const messages: UIMessage[] = [
    discoveryMessage([{
      outcomeId: "step-1",
      role: "trigger",
      askOptions: [
        { id: "gmail", label: "Gmail", value: "gmail" },
        { id: "outlook", label: "Outlook", value: "outlook" },
      ],
    }]),
    {
      id: "assistant-open",
      role: "assistant",
      parts: [{
        type: "tool-pickConnectorApp",
        toolCallId: "pick-open",
        state: "input-available",
        input: { outcomeId: "step-1", role: "trigger" },
      }],
    },
  ];

  const recovered = recoverMissingPickConnectorApp({
    messages,
    state,
    pendingUiTool: null,
    nextTool: "pickConnectorApp",
    phase: "connectors",
  });

  assert.equal(recovered.injected, false);
  assert.equal(recovered.messages, messages);
});
