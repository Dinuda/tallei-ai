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
  });

  const roundTripped = loopBuilderProposalSchema.parse(JSON.parse(JSON.stringify(proposal)));
  assert.equal(roundTripped.title, proposal.title);
  assert.equal(roundTripped.definition.deliveryType, "newsletter");
  assert.equal(roundTripped.definition.presetId, undefined);
  assert.equal(roundTripped.definition.builderMeta?.preApproved, true);
  assert.equal(roundTripped.definition.agentGraph?.children.length, 2);
  assert.deepEqual(roundTripped.suggestedChannels, ["email"]);
});
