import assert from "node:assert/strict";
import test from "node:test";

import { noSlopSpecDraftSchema, noSlopSpecSchema, noSlopSpecSnapshotSchema } from "../../../src/services/loop-engine/spec-contracts.js";
import { approvedSpecSnapshot, mapLoopSpecRowForTest, normalizeBehavioralSpec, renderSpecMarkdown, specSemanticIssues } from "../../../src/services/loop-builder/specs.js";

const behavior = {
  purpose: "Produce a weekly reviewed report.",
  agents: [{
    name: "Report Writer",
    goal: "Produce the requested report.",
    guardrails: [],
    doneWhen: ["The report is complete."],
    failureModes: [],
  }],
  guardrails: [],
  successCriteria: ["The report is complete."],
  failureModes: [],
  schedule: { description: "Weekly", cron: "0 9 * * 1", timezone: "UTC" },
  delivery: { provider: "gmail", description: "Send the report after approval." },
  connectorPolicy: { allowedReadActions: [], allowedWriteActions: [] },
  inputRequirements: [],
};

test("behavioral specs can be approved before exact connector action selection", () => {
  assert.equal(noSlopSpecDraftSchema.safeParse(behavior).success, true);
  assert.equal(noSlopSpecSchema.safeParse(behavior).success, true);
});

test("spec layer does not rewrite or heuristically reject model-owned semantics", () => {
  const parsed = noSlopSpecDraftSchema.parse(behavior);
  assert.deepEqual(normalizeBehavioralSpec(parsed), parsed);
  assert.deepEqual(specSemanticIssues(parsed), []);
});

test("spec semantics preserve any explicitly requested available provider", () => {
  const parsed = noSlopSpecDraftSchema.parse(behavior);
  assert.deepEqual(
    specSemanticIssues(parsed, "customerio"),
    ["delivery.provider must preserve the explicitly requested available provider customerio; received gmail."],
  );
  assert.deepEqual(
    specSemanticIssues({
      ...parsed,
      delivery: { ...parsed.delivery, provider: "customer_io" },
    }, "customerio"),
    [],
  );
});

test("spec markdown preserves behavioral delivery without injecting action slugs", () => {
  const markdown = renderSpecMarkdown(noSlopSpecSchema.parse(behavior));
  assert.match(markdown, /Provider: gmail/);
  assert.doesNotMatch(markdown, /GMAIL_SEND/);
});

test("spec markdown hides implementation connector actions from approval copy", () => {
  const markdown = renderSpecMarkdown(noSlopSpecSchema.parse({
    ...behavior,
    connectorPolicy: {
      allowedReadActions: [],
      allowedWriteActions: [{ toolkit: "gmail", actionSlug: "GMAIL_CREATE_EMAIL_DRAFT", risk: "write" }],
    },
  }));
  assert.match(markdown, /Runtime actions are bound from the approved Connected Apps configuration/);
  assert.doesNotMatch(markdown, /GMAIL_CREATE_EMAIL_DRAFT/);
});

test("approved snapshots retain reviewed intent context", () => {
  const specJson = noSlopSpecSchema.parse(behavior);
  const snapshot = noSlopSpecSnapshotSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "weekly-report",
    version: 1,
    title: "Weekly report",
    bodyMarkdown: renderSpecMarkdown(specJson),
    specJson,
    approvedAt: "2026-06-12T00:00:00.000Z",
  });
  const view = mapLoopSpecRowForTest({
    id: snapshot.id,
    slug: snapshot.slug,
    title: snapshot.title,
    status: "approved",
    version: snapshot.version,
    source_prompt: "Produce a weekly report.",
    body_markdown: snapshot.bodyMarkdown,
    spec_json: snapshot.specJson,
    approved_at: snapshot.approvedAt,
    approved_by_user_id: "11111111-1111-4111-8111-111111111111",
    created_at: snapshot.approvedAt,
    updated_at: snapshot.approvedAt,
  });
  assert.equal(approvedSpecSnapshot(view).specJson.purpose, behavior.purpose);
});
