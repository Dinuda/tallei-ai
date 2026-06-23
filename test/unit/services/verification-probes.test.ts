import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProbePayload,
  extractProbeChainState,
  summarizeProbePayload,
} from "../../../src/services/conductor/services/verification-probes.js";
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
      definition: { goal: "Draft replies" },
    },
  );

  assert.equal(payload.subject, "Draft replies");
  assert.equal(payload.body, "Draft replies");
  assert.equal(payload.to, "verifier@test.local");
  assert.match(summarizeProbePayload(payload), /subject: "Draft replies"/);
});

test("extractProbeChainState captures created draft id for chained send probe", () => {
  const patch = extractProbeChainState(
    { toolkit: "gmail", actionSlug: "GMAIL_CREATE_EMAIL_DRAFT", role: "critical", probeKind: "dry_run" },
    { data: { draft: { id: "draft-123" } } },
  );
  assert.equal(patch.createdDraftId, "draft-123");
});
