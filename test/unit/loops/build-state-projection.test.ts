import assert from "node:assert/strict";
import test from "node:test";

import type { LoopBuildEvent } from "../../../src/loops/build-events.js";
import {
  commitBuildArtifact,
  createBuildState,
} from "../../../src/loops/build-state.js";
import {
  projectBuildStateFromEvents,
  projectConsumedHandoffIds,
  projectLatestPhaseTurn,
  projectLoopBuild,
} from "../../../src/loops/build-state-projection.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function artifactEvent(
  sequence: number,
  committed: ReturnType<typeof commitBuildArtifact>,
  source = "intent",
): LoopBuildEvent {
  return {
    id: `event-${sequence}`,
    loopId: "loop-1",
    threadKind: "build",
    runId: null,
    sequence,
    eventKey: `artifact:${committed.envelope.id}`,
    type: "artifact.committed",
    payload: {
      phase: committed.envelope.phase,
      source,
      envelope: committed.envelope,
      invalidatedPhases: committed.invalidatedPhases,
      state: committed.state,
    },
    toolCallId: null,
    createdAt: new Date().toISOString(),
  };
}

test("projectBuildStateFromEvents returns latest artifact state", () => {
  const intent = commitBuildArtifact({
    state: createBuildState(),
    phase: "intent",
    artifact: {
      workspaceId,
      intent: { goal: "Goal", outcome: "Outcome", successCriteria: [] },
      startCondition: "Manual",
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
        summary: "Outcome",
        outcomes: [{ id: "step-1", role: "trigger", description: "Start", status: "pending" }],
      },
      profile: "agentic",
      approval: {},
      guardrails: {},
    },
  });
  const events = [
    artifactEvent(1, intent),
    artifactEvent(2, blueprint, "blueprint"),
  ];
  const projected = projectBuildStateFromEvents(events);
  assert.equal(projected?.buildPhase, "connectors");
  assert.ok(projected?.artifacts.blueprint);
});

test("projectBuildStateFromEvents prefers recovery over older artifact", () => {
  const intent = commitBuildArtifact({
    state: createBuildState(),
    phase: "intent",
    artifact: {
      workspaceId,
      intent: { goal: "Goal", outcome: "Outcome", successCriteria: [] },
      startCondition: "Manual",
      sourceHints: [],
    },
  });
  const recovered = {
    state: { ...intent.state, buildPhase: "intent" as const },
    invalidatedPhases: ["blueprint"],
  };
  const events: LoopBuildEvent[] = [
    artifactEvent(1, intent),
    {
      id: "event-2",
      loopId: "loop-1",
      threadKind: "build",
      runId: null,
      sequence: 2,
      eventKey: "phase-recovery:compile:hash:reason",
      type: "phase.recovery_requested",
      payload: {
        sourcePhase: "test",
        recoveryPhase: "compile",
        parentArtifactHash: "review-hash",
        reason: "compiled_plan_hash_mismatch",
        invalidatedPhases: ["test", "activation"],
        continuation: "next_phase",
        state: recovered.state,
      },
      toolCallId: null,
      createdAt: new Date().toISOString(),
    },
  ];
  assert.equal(projectBuildStateFromEvents(events)?.buildPhase, "intent");
});

test("projectLoopBuild projects phase turn and consumed handoffs", () => {
  const intent = commitBuildArtifact({
    state: createBuildState(),
    phase: "intent",
    artifact: {
      workspaceId,
      intent: { goal: "Goal", outcome: "Outcome", successCriteria: [] },
      startCondition: "Manual",
      sourceHints: [],
    },
  });
  const events: LoopBuildEvent[] = [
    artifactEvent(1, intent),
    {
      id: "event-2",
      loopId: "loop-1",
      threadKind: "build",
      runId: null,
      sequence: 2,
      eventKey: "phase-turn:intent:root:budget_exhausted:6:6",
      type: "phase_turn.completed",
      payload: {
        phase: "intent",
        parentArtifactHash: "root",
        stepsUsed: 6,
        stepLimit: 6,
        outcome: "budget_exhausted",
        continuation: "stop",
      },
      toolCallId: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "event-3",
      loopId: "loop-1",
      threadKind: "build",
      runId: null,
      sequence: 3,
      eventKey: "phase-handoff-consumed:handoff-1",
      type: "phase_handoff.consumed",
      payload: { handoffId: "handoff-1", phase: "intent", nextPhase: "connectors" },
      toolCallId: null,
      createdAt: new Date().toISOString(),
    },
  ];
  const projection = projectLoopBuild(events);
  assert.equal(projection.latestPhaseTurn?.outcome, "budget_exhausted");
  assert.deepEqual(projectConsumedHandoffIds(events), ["handoff-1"]);
  assert.equal(projectLatestPhaseTurn(events)?.stepsUsed, 6);
  assert.equal(projection.state?.buildPhase, "blueprint");
});

test("projectLatestPhaseTurn preserves pending user-input metadata", () => {
  const event: LoopBuildEvent = {
    id: "event-waiting",
    loopId: "loop-1",
    threadKind: "build",
    runId: null,
    sequence: 1,
    eventKey: "phase-turn:intent:root:waiting",
    type: "phase_turn.completed",
    payload: {
      phase: "intent",
      parentArtifactHash: "root",
      stepsUsed: 1,
      stepLimit: 6,
      outcome: "waiting_for_user",
      continuation: "wait_for_user",
      pendingToolCallId: "question-1",
      resumeAfterAnswer: true,
    },
    toolCallId: null,
    createdAt: new Date().toISOString(),
  };

  assert.equal(projectLatestPhaseTurn([event])?.pendingToolCallId, "question-1");
  assert.equal(projectLatestPhaseTurn([event])?.resumeAfterAnswer, true);
});
