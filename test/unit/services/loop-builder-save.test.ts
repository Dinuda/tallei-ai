import assert from "node:assert/strict";
import test from "node:test";

import { buildLoopDefinitionFromCeoDesign } from "../../../src/services/loop-executor/creator.js";
import { loopBuilderProposalSchema } from "../../../src/services/loop-builder/intent-resolver.js";

test("loop builder proposal survives JSON round-trip for save", () => {
  const definition = buildLoopDefinitionFromCeoDesign({
    goal: "Weekly newsletter to subscribers",
    design: {
      agentGraph: {
        parent: {
          id: "parent_agent",
          name: "Parent Agent",
          task: "Coordinate newsletter production and broadcast.",
          policy: "Route work to specialists; gate delivery behind approval.",
        },
        children: [
          {
            id: "writer",
            name: "Writer",
            task: "Write subscriber-ready draft.",
            tools: [{ ref: "internal.llm_only" }],
          },
          {
            id: "approval_handoff",
            name: "Approval Handoff",
            task: "Send draft for approval and prepare broadcast email.",
            tools: [
              { ref: "internal.email_approval_request" },
              { ref: "internal.email_builder_compose" },
              { ref: "internal.email_builder_render" },
            ],
          },
        ],
      },
      schedule: { cron: "0 9 * * 1", timezone: "UTC" },
      deliveryType: "newsletter",
      builderMeta: {
        designedBy: "ceo_llm",
        preApproved: true,
        model: "gpt-4o",
      },
    },
  });

  const proposal = loopBuilderProposalSchema.parse({
    title: "Tallei weekly newsletter",
    summary: "Research, write, approve, and broadcast to subscribers.",
    templateId: "custom",
    definition,
    suggestedChannels: ["email (Resend broadcast)"],
    suggestedToolRefs: ["internal.llm_only", "internal.email_approval_request"],
    memories: [],
    preferences: [],
    rationale: ["User wants subscriber broadcast delivery."],
    designedBy: "ceo_llm",
    model: "gpt-4o",
    trace: {
      stages: [
        {
          stage: "delivery_classification",
          model: "deterministic",
          input: { prompt: "Weekly newsletter to subscribers" },
          output: { deliveryType: "newsletter" },
        },
      ],
    },
  });

  const roundTripped = loopBuilderProposalSchema.parse(JSON.parse(JSON.stringify(proposal)));
  assert.equal(roundTripped.title, proposal.title);
  assert.equal(roundTripped.definition.deliveryType, "newsletter");
  assert.equal(roundTripped.definition.presetId, undefined);
  assert.equal(roundTripped.definition.builderMeta?.preApproved, true);
  assert.equal(roundTripped.definition.agentGraph?.children.length, 2);
  assert.deepEqual(roundTripped.suggestedChannels, ["email"]);
  assert.equal(roundTripped.trace?.stages.length, 1);
  assert.equal(roundTripped.trace?.stages[0]?.stage, "delivery_classification");
});

test("loop builder proposal treats null presetId as omitted on save payloads", () => {
  const definition = buildLoopDefinitionFromCeoDesign({
    goal: "Weekly newsletter to subscribers",
    design: {
      agentGraph: {
        parent: {
          id: "parent_agent",
          name: "Parent Agent",
          task: "Coordinate newsletter production and broadcast.",
          policy: "Route work to specialists; gate delivery behind approval.",
        },
        children: [
          {
            id: "writer",
            name: "Writer",
            task: "Write subscriber-ready draft.",
            tools: [{ ref: "internal.llm_only" }],
          },
          {
            id: "broadcast_delivery",
            name: "Broadcast Delivery Agent",
            task: "Broadcast approved content only.",
            tools: [{ ref: "internal.resend_broadcast" }],
          },
        ],
      },
      schedule: { cron: "0 9 * * 1", timezone: "UTC" },
      deliveryType: "newsletter",
      builderMeta: {
        designedBy: "ceo_llm",
        preApproved: true,
      },
    },
  });
  const payload = JSON.parse(JSON.stringify({
    title: "Tallei weekly newsletter",
    summary: "Research, write, approve, and broadcast to subscribers.",
    templateId: "newsletter_broadcast",
    definition,
    suggestedChannels: ["email"],
    suggestedToolRefs: ["internal.llm_only", "internal.resend_broadcast"],
    memories: [],
    preferences: [],
    rationale: ["User wants subscriber broadcast delivery."],
    designedBy: "ceo_llm",
    trace: {
      stages: [
        {
          stage: "delivery_classification",
          model: "deterministic",
          input: { prompt: "Weekly newsletter to subscribers" },
          output: { deliveryType: "newsletter" },
        },
      ],
    },
  }));
  payload.definition.presetId = null;

  const parsed = loopBuilderProposalSchema.parse(payload);
  assert.equal(parsed.definition.deliveryType, "newsletter");
  assert.equal(parsed.definition.presetId, undefined);
  assert.equal(parsed.trace?.stages[0]?.stage, "delivery_classification");
});

test("loop builder proposal treats blank presetId as omitted on save payloads", () => {
  const definition = buildLoopDefinitionFromCeoDesign({
    goal: "Weekly newsletter to subscribers",
    design: {
      agentGraph: {
        parent: {
          id: "parent_agent",
          name: "Parent Agent",
          task: "Coordinate newsletter production and broadcast.",
          policy: "Route work to specialists; gate delivery behind approval.",
        },
        children: [
          {
            id: "writer",
            name: "Writer",
            task: "Write subscriber-ready draft.",
            tools: [{ ref: "internal.llm_only" }],
          },
        ],
      },
      schedule: { cron: "0 9 * * 1", timezone: "UTC" },
      deliveryType: "newsletter",
      presetId: "   ",
      builderMeta: {
        designedBy: "ceo_llm",
        preApproved: true,
      },
    },
  });
  const payload = loopBuilderProposalSchema.parse({
    title: "Tallei weekly newsletter",
    summary: "Research, write, approve, and broadcast to subscribers.",
    templateId: "newsletter_broadcast",
    definition,
    suggestedChannels: ["email"],
    suggestedToolRefs: ["internal.llm_only"],
    memories: [],
    preferences: [],
    rationale: ["User wants subscriber broadcast delivery."],
    designedBy: "ceo_llm",
  });
  assert.equal(payload.definition.presetId, undefined);
});
