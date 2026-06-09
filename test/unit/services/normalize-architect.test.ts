import assert from "node:assert/strict";
import test from "node:test";

import type { LoopArchitectOutput } from "../../../src/services/loop-engine/contracts.js";
import { critiqueLoopDesign } from "../../../src/services/loop-engine/critic.js";
import { normalizeArchitectOutput } from "../../../src/services/loop-engine/normalize-architect.js";

function newsletterDesign(): LoopArchitectOutput {
  return {
    title: "Weekly digest",
    summary: "Curated newsletter from research and memories.",
    strategyText: "Research, recall memories, write newsletter.",
    inputsRequired: [],
    delivery: { provider: "none", target: "none" },
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    agents: [
      {
        id: "research",
        name: "Research Agent",
        goal: "Find newsletter sources",
        task: "Search the web for recent articles.",
        tool: "internal.web_search",
        inputContract: { description: "Topic", schema: {} },
        outputContract: { description: "Sources", schema: {} },
        doneCriteria: ["Returns cited sources"],
      },
      {
        id: "writer",
        name: "Newsletter Writer",
        goal: "Write the newsletter email",
        task: "Synthesize sources into a newsletter email body.",
        tool: "internal.llm_only",
        inputContract: { description: "Sources", schema: {} },
        outputContract: { description: "Newsletter email copy", schema: {} },
        doneCriteria: ["Includes subject and body"],
      },
      {
        id: "editorial_review",
        name: "Editorial Review Agent",
        goal: "Review upstream newsletter quality",
        task: "Review the writer output without rewriting the full newsletter.",
        tool: "internal.llm_only",
        inputContract: { description: "Draft", schema: {} },
        outputContract: { description: "Review notes", schema: {} },
        doneCriteria: ["Flags quality issues"],
        gate: { type: "draft_review", question: "Approve?" },
      },
      {
        id: "delivery_prep",
        name: "Delivery Preparation Agent",
        goal: "Prepare the newsletter email for delivery",
        task: "Format the newsletter email for sending after review.",
        tool: "internal.llm_only",
        inputContract: { description: "Approved draft", schema: {} },
        outputContract: { description: "Newsletter email ready to send", schema: {} },
        doneCriteria: ["Email is ready"],
        gate: { type: "pre_send", question: "Approve send?" },
      },
    ],
    rationale: [],
    suggestedChannels: ["primary"],
  };
}

test("normalize removes editorial QA agent and fixes delivery prep writer", () => {
  const normalized = normalizeArchitectOutput(newsletterDesign());
  assert.equal(normalized.agents.some((agent) => /editorial review/i.test(agent.name)), false);
  const writer = normalized.agents.find((agent) => /newsletter writer/i.test(agent.name));
  assert.ok(writer);
  assert.equal(writer?.renderTarget, "canvas.email");
  assert.equal(writer?.gate?.type, "draft_review");
  assert.equal(writer?.artifactRole, "draft_body");
  assert.equal(normalized.agents.some((agent) => /delivery preparation/i.test(agent.name)), false);
  assert.equal(normalized.agents.find((agent) => agent.tool === "internal.web_search")?.gate?.type, "source_confirmation");
});

test("normalize injects missing spec guardrails into strategy and writer criteria", () => {
  const guardrail = "Ensure summaries are readable at a glance and suitable for a general professional audience.";
  const normalized = normalizeArchitectOutput(newsletterDesign(), {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "digest",
    version: 1,
    title: "Digest",
    bodyMarkdown: "# Digest",
    approvedAt: "2026-06-09T00:00:00.000Z",
    specJson: {
      purpose: "Weekly digest",
      agents: [{
        name: "Writer",
        goal: "Write digest",
        guardrails: [guardrail],
        doneWhen: ["Digest is ready for review"],
        failureModes: [],
      }],
      guardrails: [],
      successCriteria: [],
      failureModes: [],
      schedule: { description: "Weekly", cron: "0 9 * * 1", timezone: "UTC" },
      delivery: { target: "none", description: "Dashboard only" },
    },
  } as never);
  assert.match(normalized.strategyText, /readable at a glance/i);
  const writer = normalized.agents.find((agent) => /newsletter writer/i.test(agent.name));
  assert.ok(writer?.doneCriteria.includes(guardrail));
});
