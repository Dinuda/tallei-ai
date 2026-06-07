import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasEmailTemplate } from "../../../src/services/loop-runtime/email-canvas.js";
import { runtimeDefinitionSchema } from "../../../src/services/loop-runtime/types.js";
import { listLoopTools } from "../../../src/services/loop-executor/tool-catalog.js";

function stableDefinition() {
  return {
    definitionVersion: "loop_executor_v2",
    engineVersion: "loop_engine_v3",
    goal: "Create a reviewed weekly brief",
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    schedulerTarget: "internal",
    allowedIntegrations: ["internal"],
    ceo: { name: "Parent", task: "Coordinate", policy: "Use reviewed artifacts" },
    draftPolicy: { requireDraftBeforeExternalAction: true, approvalRequiredFor: [] },
    delivery: { provider: "none", target: "none" },
    agentGraph: {
      parent: { id: "parent", name: "Parent", task: "Coordinate", policy: "Use reviewed artifacts" },
      children: [{
        id: "writer",
        name: "Writer",
        task: "Write the brief",
        goal: "Produce a complete brief",
        tools: [{ ref: "internal.llm_only" }],
        gate: { type: "draft_review", question: "Approve this brief?" },
      }],
    },
  };
}

test("stable runtime accepts a v3 artifact-only definition", () => {
  assert.equal(runtimeDefinitionSchema.parse(stableDefinition()).engineVersion, "loop_engine_v3");
});

test("stable runtime accepts canvas.email and canvas.preview as a render target, not a tool", () => {
  const parsed = runtimeDefinitionSchema.parse({
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        ...stableDefinition().agentGraph.children[0],
        renderTarget: "canvas.email",
      }],
    },
  });
  assert.equal(parsed.agentGraph?.children[0]?.renderTarget, "canvas.email");
  assert.equal(listLoopTools().some((tool) => tool.ref === "canvas.email"), false);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        ...stableDefinition().agentGraph.children[0],
        renderTarget: "canvas.preview",
      }],
    },
  }).success, true);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    agentGraph: {
      ...stableDefinition().agentGraph,
      children: [{
        ...stableDefinition().agentGraph.children[0],
        renderTarget: "canvas.document",
      }],
    },
  }).success, false);
});

test("stable runtime rejects legacy definitions and outbound delivery", () => {
  assert.equal(runtimeDefinitionSchema.safeParse({ ...stableDefinition(), engineVersion: undefined }).success, false);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    delivery: { provider: "composio.gmail.send_email", target: "team_email" },
  }).success, false);
  assert.equal(runtimeDefinitionSchema.safeParse({
    ...stableDefinition(),
    presetId: "newsletter",
  }).success, false);
});

test("canvas email renderer returns editable template without delivery footer", () => {
  const template = buildCanvasEmailTemplate({
    markdown: [
      "Subject: Product update",
      "Preview: The short version.",
      "",
      "# Product update",
      "",
      "We shipped **stable loops**.",
      "- No outbound delivery",
    ].join("\n"),
  });
  assert.equal(template.subject, "Product update");
  assert.equal(template.preview, "The short version.");
  assert.equal(template.source, "runtime");
  assert.match(template.html, /stable loops/);
  assert.equal(template.html.includes("RESEND_UNSUBSCRIBE_URL"), false);
  assert.equal(template.design.body.rows.length > 0, true);
});
