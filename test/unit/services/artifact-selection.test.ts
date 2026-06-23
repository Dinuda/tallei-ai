import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArtifactDeliveryPayload,
  selectLatestArtifactsByKey,
  selectPreferredArtifact,
} from "../../../src/services/conductor/runtime/artifact-selection.js";

test("prefers the configured rendered artifact over later research artifacts", () => {
  const artifacts = [
    {
      artifact_key: "web_research_output",
      kind: "structured_output",
      body: "Research notes",
      data_json: { sources: [{ title: "Example" }] },
      created_at: "2026-06-10T10:00:00.000Z",
      version: 1,
      step_index: 0,
    },
    {
      artifact_key: "newsletter_writer_output",
      kind: "structured_output",
      body: "Here's the newsletter draft body.",
      data_json: {
        renderer: "canvas.email",
        emailTemplate: {
          html: "<p>Here's the newsletter draft body.</p>",
          text: "Here's the newsletter draft body.",
          subject: "AI Weekly Digest",
          preview: "Top AI stories from the last week",
        },
      },
      created_at: "2026-06-10T10:05:00.000Z",
      version: 1,
      step_index: 1,
    },
    {
      artifact_key: "recipient_list_agent_output",
      kind: "structured_output",
      body: "Recipient list saved",
      data_json: { recipientCount: 42 },
      created_at: "2026-06-10T10:10:00.000Z",
      version: 1,
      step_index: 2,
    },
  ];

  const latest = selectLatestArtifactsByKey(artifacts);
  const selected = selectPreferredArtifact(latest);

  assert.equal(selected?.artifact_key, "newsletter_writer_output");
  assert.equal(selected?.body, "Here's the newsletter draft body.");

  const payload = buildArtifactDeliveryPayload(selected);
  assert.deepEqual(payload, {
    content: "<p>Here's the newsletter draft body.</p>",
    html: "<p>Here's the newsletter draft body.</p>",
    text: "Here's the newsletter draft body.",
    subject: "AI Weekly Digest",
    preview: "Top AI stories from the last week",
  });
});

test("falls back to the newest artifact when no draft artifact exists", () => {
  const artifacts = [
    {
      artifact_key: "web_research_output",
      kind: "structured_output",
      body: "Research notes",
      data_json: { sources: [{ title: "Example" }] },
      created_at: "2026-06-10T10:00:00.000Z",
      version: 1,
      step_index: 0,
    },
    {
      artifact_key: "recipient_list_agent_output",
      kind: "structured_output",
      body: "Recipient list saved",
      data_json: { recipientCount: 42 },
      created_at: "2026-06-10T10:10:00.000Z",
      version: 1,
      step_index: 1,
    },
  ];

  const latest = selectLatestArtifactsByKey(artifacts);
  const selected = selectPreferredArtifact(latest);

  assert.equal(selected?.artifact_key, "recipient_list_agent_output");
  assert.equal(selected?.body, "Recipient list saved");
  assert.deepEqual(buildArtifactDeliveryPayload(selected), {
    content: "Recipient list saved",
  });
});
