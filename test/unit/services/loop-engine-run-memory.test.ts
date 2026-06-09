import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGateDecisionToRunMemory,
  buildAgentHandoff,
  emptyRunMemory,
  hasRequiredRunInputs,
  resolveRequiredInputKeys,
} from "../../../src/services/loop-runtime/memory.js";
import { detectPlaceholderText } from "../../../src/services/loop-engine/contracts.js";
import { evaluateAgentGoal } from "../../../src/services/loop-engine/goal-eval.js";
import { buildAgentUserPrompt } from "../../../src/services/loop-executor/tool-catalog.js";

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

test("agent prompt pins structured handoff inputs ahead of bulky prior context", () => {
  const sprintNotes = [
    "Sprint Goal: Improve memory persistence and add user workspace isolation",
    "Completed:",
    "- Implemented persistent storage API endpoints",
    "- Added workspace authentication layer",
  ].join("\n");
  const hugeMemoryBlob = "memory excerpt ".repeat(2_000);
  const handoff = buildAgentHandoff(
    {
      id: "draft_writer",
      name: "Internal Draft Writer",
      task: "Use the validated sprint_notes to write the internal sync email.",
      tools: [{ ref: "internal.llm_only" }],
    },
    {
      ...emptyRunMemory(),
      inputs: { sprint_notes: sprintNotes },
      approvedMemories: Array.from({ length: 25 }, (_, index) => ({
        id: `mem-${index}`,
        excerpt: `${hugeMemoryBlob}${index}`,
      })),
    },
    {
      memory_search_output: {
        artifactId: "memory_search_output",
        body: hugeMemoryBlob,
      },
    },
  );

  const prompt = buildAgentUserPrompt({
    goal: "Write an update from [PASTE SPRINT NOTES / TASKS HERE].",
    agentTask: "Using approved memories and the validated sprint_notes, write a casual internal sync.",
    priorComments: [{ author: "memory_search_output", body: hugeMemoryBlob }],
    agentHandoff: handoff,
  });

  assert.match(prompt, /Authoritative agent handoff:/);
  assert.match(prompt, /Sprint Goal: Improve memory persistence/);
  assert.ok(prompt.indexOf("Sprint Goal: Improve memory persistence") < prompt.indexOf("[PASTE SPRINT NOTES / TASKS HERE]"));
});

test("input validator placeholder output opens missing input gate instead of failing", async () => {
  const result = await evaluateAgentGoal({
    agent: {
      id: "input_validator",
      name: "Inputs Validator",
      task: "Check that sprint_notes are present and readable.",
      goal: "Confirm sprint_notes are provided.",
      tools: [{ ref: "internal.llm_only" }],
      gate: { type: "missing_input", question: "Paste sprint notes to continue." },
    },
    result: {
      text: [
        "Short checklist:",
        "- sprint_notes present: No. The input is a placeholder [PASTE SPRINT NOTES / TASKS HERE] instead of actual content.",
        "- Readability assessable: Not assessable yet; need real sprint notes.",
        "- Next steps to proceed: Paste the actual sprint notes.",
      ].join("\n"),
      data: {},
    },
    definition: {
      inputsRequired: ["sprint_notes"],
      goal: "Create weekly product sync email from [PASTE SPRINT NOTES / TASKS HERE].",
    },
    runMemory: emptyRunMemory(),
    skipLlmJudge: true,
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.gateType, "missing_input");
  assert.deepEqual(result.blockers, ["sprint_notes"]);
});

test("input checker output that verifies notes are present passes instead of asking again", async () => {
  const result = await evaluateAgentGoal({
    agent: {
      id: "input_checker",
      name: "Input Checker",
      task: "Check that sprint_notes are present and readable.",
      goal: "Confirm sprint_notes are provided.",
      tools: [{ ref: "internal.llm_only" }],
      gate: { type: "missing_input", question: "Please provide the sprint notes." },
    },
    result: {
      text: [
        "Verification result:",
        "",
        "sprint_notes input provided: yes",
        "",
        "Fields present in the input:",
        "Sprint Goal",
        "Completed",
        "In Progress",
        "Blockers",
        "",
        "Missing fields: none detected",
      ].join("\n"),
      data: {},
    },
    definition: {
      inputsRequired: ["sprint_notes"],
      goal: "Create weekly product sync email.",
    },
    runMemory: emptyRunMemory(),
    skipLlmJudge: true,
  });

  assert.equal(result.status, "pass");
});

test("draft review output with normal pending work language opens draft gate", async () => {
  const draft = [
    "Progress on past items",
    "",
    "Multi-tenant data isolation: 70% complete; edge-case/open criteria still outstanding.",
    "API documentation generation: pending final review.",
    "",
    "Shipped this week",
    "",
    "Memory retrieval now filters unrelated personal memories before drafting.",
    "",
    "In progress",
    "",
    "Dashboard review flow hardening is still in progress.",
    "",
    "Things to watch",
    "",
    "Approval gates should only advance on explicit operator approval.",
    "",
    "Going out to customers",
    "",
    "Partial, after internal review.",
    "",
    "Next week",
    "",
    "Finish durable run continuation and retry recovery.",
  ].join("\n");

  assert.equal(detectPlaceholderText(draft), false);

  const result = await evaluateAgentGoal({
    agent: {
      id: "internal_sync_draft_writer",
      name: "Internal Sync Draft Writer",
      task: "Write the internal sync email from validated sprint notes.",
      goal: "Produce a complete internal product sync email.",
      tools: [{ ref: "internal.llm_only" }],
      gate: { type: "draft_review", question: "Review and approve this internal sync email?" },
    },
    result: { text: draft, data: {} },
    definition: {
      inputsRequired: ["sprint_notes"],
      goal: "Create weekly product sync email.",
    },
    runMemory: {
      ...emptyRunMemory(),
      inputs: { sprint_notes: "Memory retrieval filtering shipped. Gate continuation hardening in progress." },
    },
    skipLlmJudge: true,
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.gateType, "draft_review");
});

test("newsletter writer with missing delivery config opens draft review not missing input", async () => {
  const draft = [
    "Subject: This Week in AI",
    "",
    "Preview: Siri overhaul, liability questions, and Gemini architectures.",
    "",
    "Hello AI Readers,",
    "",
    "Apple's long-awaited AI Siri overhaul is finally here.",
    "The lawsuits that could give AI its Big Tobacco moment continue to unfold.",
  ].join("\n");

  const result = await evaluateAgentGoal({
    agent: {
      id: "newsletter_writer",
      name: "Writer Agent",
      task: "Write the weekly AI industry newsletter from research sources.",
      goal: "Produce a complete newsletter draft ready for human review.",
      tools: [{ ref: "internal.llm_only" }],
      gate: { type: "draft_review", question: "Review this newsletter draft?" },
      renderTarget: "canvas.email",
    },
    result: { text: draft, data: {} },
    definition: {
      inputsRequired: ["subscriber_list_id"],
      goal: "Write and send a weekly AI industry newsletter.",
    },
    runMemory: emptyRunMemory(),
    skipLlmJudge: true,
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.gateType, "draft_review");
});

test("draft placeholder output with required input present opens draft review gate", async () => {
  const result = await evaluateAgentGoal({
    agent: {
      id: "internal_sync_draft_writer",
      name: "Internal Sync Draft Writer",
      task: "Write the internal sync email from validated sprint notes.",
      goal: "Produce a complete internal product sync email.",
      tools: [{ ref: "internal.llm_only" }],
      gate: { type: "draft_review", question: "Review and approve this internal sync email?" },
    },
    result: {
      text: "Team,\n\nHere are this week's updates:\n\n[PASTE SPRINT NOTES / TASKS HERE]",
      data: {},
    },
    definition: {
      inputsRequired: ["sprint_notes"],
      goal: "Create weekly product sync email.",
    },
    runMemory: {
      ...emptyRunMemory(),
      inputs: { sprint_notes: "Memory retrieval filtering shipped. Gate continuation hardening in progress." },
    },
    skipLlmJudge: true,
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.gateType, "draft_review");
  assert.deepEqual(result.blockers, ["placeholder_detected"]);
});
