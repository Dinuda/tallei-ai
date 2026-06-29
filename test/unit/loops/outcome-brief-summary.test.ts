import assert from "node:assert/strict";
import test from "node:test";

import { buildOutcomeBrief } from "../../../src/loops/outcome-brief.js";
import { fallbackOutcomeBriefUserSummary } from "../../../src/loops/outcome-brief-summary.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("fallbackOutcomeBriefUserSummary uses blueprint descriptions not slug maps", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.intent.outcome = "Classify support emails and draft replies";
  spec.intent.goal = "Help me respond to parent emails faster";
  spec.taskBlueprint = {
    version: 1,
    summary: "Support inbox",
    outcomes: [
      {
        id: "trigger",
        role: "trigger",
        description: "When a new email arrives in Gmail",
        selectedConnector: "gmail",
        status: "chosen",
      },
      {
        id: "reply",
        role: "destination",
        description: "Draft a reply in Gmail for your review",
        selectedConnector: "gmail",
        status: "chosen",
      },
    ],
  };
  spec.approval.mode = "ask";
  spec.approval.sensitiveCapabilities = ["email.send"];

  const brief = buildOutcomeBrief(spec);
  const summary = fallbackOutcomeBriefUserSummary(spec, brief);

  assert.equal(summary.whenItRuns, "When a new email arrives in Gmail");
  assert.ok(summary.steps.some((line) => line.includes("Draft a reply")));
  assert.match(summary.beforeSending, /approve/i);
  assert.ok(!summary.whenItRuns.includes("GMAIL_NEW"));
  assert.ok(!summary.steps.join(" ").includes("GMAIL_FETCH"));
});
