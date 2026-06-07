import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGateDecisionToRunMemory,
  buildAgentHandoff,
  emptyRunMemory,
  hasRequiredRunInputs,
  resolveRequiredInputKeys,
} from "../../../src/services/loop-engine/run-memory.js";

test("applyGateDecisionToRunMemory stores sprint_notes from missing_input gate", () => {
  const patch = applyGateDecisionToRunMemory({
    gateType: "missing_input",
    decision: { value: "Shipped recall fix.\nIn progress: dedup rollout." },
    definition: { inputsRequired: ["sprint_notes"] },
  });

  assert.deepEqual(patch.inputs, {
    sprint_notes: "Shipped recall fix.\nIn progress: dedup rollout.",
  });
});

test("resolveRequiredInputKeys falls back to agent graph provided inputs", () => {
  const keys = resolveRequiredInputKeys({
    agentGraph: {
      parent: { name: "CEO", task: "Run loop", policy: "safe" },
      children: [{
        id: "input_validator",
        name: "Input Validator",
        task: "Validate",
        goal: "Validate inputs",
        tools: [{ ref: "internal.llm_only" }],
        inputContract: {
          description: "provided",
          schema: { provided: { sprint_notes: "string?" } },
        },
      }],
    },
  });
  assert.deepEqual(keys, ["sprint_notes"]);
});

test("hasRequiredRunInputs is true after operator paste", () => {
  assert.equal(hasRequiredRunInputs(
    { inputsRequired: ["sprint_notes"] },
    { ...emptyRunMemory(), inputs: { sprint_notes: "Shipped recall fix." } },
  ), true);
});

test("applyGateDecisionToRunMemory stores approved memories from memory_confirmation gate", () => {
  const patch = applyGateDecisionToRunMemory({
    gateType: "memory_confirmation",
    decision: {
      items: [
        { id: "mem-1", excerpt: "Recall fix shipped.", include: true },
        { id: "mem-2", excerpt: "Excluded memory.", include: false },
      ],
    },
    definition: {},
  });

  assert.deepEqual(patch.approvedMemories, [
    { id: "mem-1", excerpt: "Recall fix shipped." },
  ]);
});

test("buildAgentHandoff injects run memory and prior agent artifacts for draft writer", () => {
  const handoff = buildAgentHandoff(
    {
      id: "draft_writer",
      name: "Draft Writer",
      task: "Write the sync email.",
      tools: [{ ref: "internal.llm_only" }],
    },
    {
      ...emptyRunMemory(),
      inputs: { sprint_notes: "Shipped recall fix this week." },
      approvedMemories: [{ id: "mem-1", excerpt: "Recall fix shipped." }],
    },
    {
      memory_search: {
        artifactId: "memory_search_output",
        body: "Found 1 memories (id + excerpt):\n- [mem-1] Recall fix shipped.",
        data: { sources: [{ id: "mem-1", text: "Recall fix shipped." }] },
      },
    },
  );

  assert.equal(handoff.sprint_notes, "Shipped recall fix this week.");
  assert.deepEqual(handoff.memories, [{ id: "mem-1", excerpt: "Recall fix shipped." }]);
  assert.deepEqual(handoff.approved_memories, [{ id: "mem-1", excerpt: "Recall fix shipped." }]);
  assert.ok(handoff.memory_search);
  assert.equal(handoff.draft_writer, undefined);
});
