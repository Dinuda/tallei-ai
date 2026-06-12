import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGateDecisionToRunMemory,
  buildAgentHandoff,
  buildOperatorRevisionPatch,
  emptyRunMemory,
  hasRequiredRunInputs,
  resolveRequiredInputKeys,
} from "../../../src/services/loop-runtime/memory.js";
import { detectPlaceholderText } from "../../../src/services/loop-engine/contracts.js";
import { evaluateAgentGoal } from "../../../src/services/loop-engine/goal-eval.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../../../src/services/loop-executor/tool-catalog.js";

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

test("resolveRequiredInputKeys returns empty when nothing is declared", () => {
  assert.deepEqual(resolveRequiredInputKeys({}), []);
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
  assert.equal(handoff.approved_memories, undefined);
  assert.equal(handoff.memories, undefined);
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

test("JSON newsletter agent receives JSON instructions instead of raw email instructions", () => {
  const prompt = buildAgentSystemPrompt({
    goal: "Weekly newsletter",
    agentName: "Newsletter Drafting Agent",
    agentTask: "Draft the weekly newsletter.",
    outputContract: {
      description: "Newsletter object",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      representation: "json",
    },
    doneCriteria: ["Newsletter is complete"],
  } as never);

  assert.match(prompt, /MANDATORY OUTPUT SCHEMA/);
  assert.doesNotMatch(prompt, /raw email_markdown text only/i);
  assert.doesNotMatch(prompt, /Do not return JSON/i);
});

test("internal synthesis agents cannot open an operator input checkpoint", async () => {
  const result = await evaluateAgentGoal({
    agent: {
      id: "research_synthesizer",
      name: "Research Synthesizer Agent",
      task: "Synthesize the available research.",
      goal: "Produce a concise brief.",
      tools: [{ ref: "internal.llm_only" }],
    },
    result: {
      text: "I cannot draft this brief. Please provide the required input and more research details.",
      data: {},
    },
    definition: { goal: "Produce a research brief." },
    runMemory: emptyRunMemory(),
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.blockers, ["invalid_operator_input_request"]);
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
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.gateType, "draft_review");
  assert.deepEqual(result.blockers, ["placeholder_detected"]);
});

test("applyGateDecisionToRunMemory stores approved web sources from source_confirmation gate", () => {
  const patch = applyGateDecisionToRunMemory({
    gateType: "source_confirmation",
    gateAgentId: "web_research",
    decision: {
      items: [
        { title: "Source A", url: "https://a.example", snippet: "Snippet A", include: true },
        { title: "Source B", url: "https://b.example", snippet: "Snippet B", include: false },
      ],
      addedSources: [
        { title: "Custom", url: "https://custom.example", snippet: "Operator added" },
      ],
    },
    definition: {},
  });

  assert.deepEqual(patch.approvedSources, {
    web_research: [
      { title: "Source A", url: "https://a.example", snippet: "Snippet A" },
      { title: "Custom", url: "https://custom.example", snippet: "Operator added" },
    ],
  });
});

test("buildAgentHandoff does not inject approved web sources as magic handoff keys", () => {
  const handoff = buildAgentHandoff(
    {
      id: "newsletter_writer",
      name: "Writer",
      task: "Write newsletter",
      tools: [{ ref: "internal.llm_only" }],
    },
    {
      ...emptyRunMemory(),
      approvedSources: {
        web_research: [{ title: "A", url: "https://a.example", snippet: "Snippet" }],
      },
    },
    {},
  );

  assert.equal(handoff.curated_web_sources, undefined);
  assert.equal(handoff["approved_sources.web_research"], undefined);
});

test("web_search with sources and source_confirmation gate pauses for operator review", async () => {
  const result = await evaluateAgentGoal({
    agent: {
      id: "web_research",
      name: "Research Agent",
      task: "Search the web",
      goal: "Return cited sources",
      tools: [{ ref: "internal.web_search" }],
      gate: { type: "source_confirmation", question: "Pick sources" },
    },
    result: {
      text: "Found 1 source.",
      data: {
        toolResults: [{
          ref: "internal.web_search",
          data: {
            sources: [{ title: "Example", url: "https://example.com", snippet: "Example snippet" }],
          },
        }],
      },
    },
    definition: { goal: "Research topic" },
    runMemory: emptyRunMemory(),
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.gateType, "source_confirmation");
});

test("buildOperatorRevisionPatch stores feedback for agent re-run", () => {
  const patch = buildOperatorRevisionPatch({
    agentId: "newsletter_writer",
    feedback: "Make the intro shorter.",
  });
  assert.equal(patch.operatorRevisions?.newsletter_writer?.feedback, "Make the intro shorter.");
  assert.ok(patch.operatorRevisions?.newsletter_writer?.at);
});
