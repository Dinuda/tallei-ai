import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProbePayload,
  extractProbeChainState,
  summarizeProbePayload,
} from "../../../src/services/loop-executor/verification-probes.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";

const createDraftContract: ToolContract = {
  toolRef: "composio.gmail.action.GMAIL_CREATE_EMAIL_DRAFT",
  provider: "composio",
  name: "Create email draft",
  description: "Create draft",
  skillTags: [],
  effect: "write_external",
  resources: ["gmail"],
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["to", "subject", "body"],
  },
  outputSchema: { type: "object" },
  executionMode: "short_circuit",
  approval: { required: false },
  renderRecommendations: [],
  constraints: { toolkit: "gmail", actionSlug: "GMAIL_CREATE_EMAIL_DRAFT", connected: true },
  source: "composio_sdk",
};

test("buildProbePayload uses approved artifact subject and body for create draft", () => {
  const payload = buildProbePayload(
    createDraftContract,
    { toolkit: "gmail", actionSlug: "GMAIL_CREATE_EMAIL_DRAFT", role: "critical", probeKind: "dry_run" },
    {
      verificationId: "verify-1",
      chainState: {},
      runnableSpec: {
        version: "v1",
        goal: "Draft replies",
        title: "Draft replies",
        noSlopSpec: {
          id: "spec-1",
          title: "Draft replies",
          bodyMarkdown: "",
          specJson: {
            purpose: "Draft replies",
            delivery: { provider: "none", description: "" },
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            agents: [],
            successCriteria: [],
          },
          approvedAt: "2026-06-15T00:00:00.000Z",
        },
        discoveredToolContracts: [],
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        artifacts: {
          mode: "supplied_template",
          templates: [{
            id: "t1",
            name: "Acknowledgment",
            templateId: "acknowledgment",
            subject: "We received your request",
            html: "<p>Thanks for reaching out.</p>",
            text: "Thanks for reaching out.",
          }],
        },
      },
    },
  );

  assert.equal(payload.subject, "We received your request");
  assert.equal(payload.body, "Thanks for reaching out.");
  assert.equal(payload.to, "verifier@test.local");
  assert.match(summarizeProbePayload(payload), /subject: "We received your request"/);
});

test("extractProbeChainState captures created draft id for chained send probe", () => {
  const patch = extractProbeChainState(
    { toolkit: "gmail", actionSlug: "GMAIL_CREATE_EMAIL_DRAFT", role: "critical", probeKind: "dry_run" },
    { data: { draft: { id: "draft-123" } } },
  );
  assert.equal(patch.createdDraftId, "draft-123");
});
