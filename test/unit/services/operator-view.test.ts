import assert from "node:assert/strict";
import test from "node:test";

import { projectOperatorView } from "../../../src/services/loop-runtime/operator-view.js";

const typedRow = (kind: string, operatorInteraction: Record<string, unknown>) => ({
  id: `interaction-${kind}`,
  interaction_kind: kind as "collect_input" | "review_artifact" | "confirm_action" | "connect_connector",
  status: "pending",
  payload_json: { operatorInteraction },
});

test("typed collect input projects server actions", () => {
  const view = projectOperatorView({
    status: "waiting_for_interaction",
    interactions: [typedRow("collect_input", {
      kind: "collect_input",
      interactionIds: ["collect:recipient"],
      items: [{
        id: "collect:recipient",
        kind: "collect_input",
        requiredValueKey: "recipient",
        consumingNodeId: "send",
        surface: "input.text",
        timing: "before_send",
        valueType: "string",
        label: "Recipient",
        description: "Recipient for this run.",
        required: true,
        satisfied: false,
      }],
    })],
  });
  assert.equal(view.blocks[0]?.kind, "collect_input");
  assert.deepEqual(view.actions.map((action) => action.command), ["submit_input"]);
});

test("typed connector interaction never projects generic text input", () => {
  const view = projectOperatorView({
    status: "waiting_for_interaction",
    interactions: [typedRow("connect_connector", {
      kind: "connect_connector",
      interactionId: "connect:send",
      actionNodeId: "send",
      contractRef: "composio.gmail.action.gmail_send_email",
      toolkit: "gmail",
      actionSlug: "GMAIL_SEND_EMAIL",
      connected: false,
    })],
  });
  assert.equal(view.blocks[0]?.kind, "connect_connector");
  assert.equal(view.blocks[0]?.surface, undefined);
  assert.deepEqual(view.actions.map((action) => action.command), ["verify_connection"]);
});

test("typed confirmation exposes the exact sanitized payload", () => {
  const view = projectOperatorView({
    status: "waiting_for_interaction",
    interactions: [typedRow("confirm_action", {
      kind: "confirm_action",
      interactionId: "confirm:send",
      actionNodeId: "send",
      contractRef: "composio.gmail.action.gmail_send_email",
      effect: "write_external",
      sanitizedPayload: { recipient_email: "team@example.com" },
      payloadHash: "hash",
      validation: { valid: true, errors: [] },
    })],
  });
  assert.deepEqual((view.blocks[0]?.data as { payload: unknown }).payload, { recipient_email: "team@example.com" });
  assert.deepEqual(view.actions.map((action) => action.command), ["reject", "approve"]);
});

test("typed review artifact projects render target and review surface", () => {
  const view = projectOperatorView({
    status: "waiting_for_interaction",
    interactions: [typedRow("review_artifact", {
      kind: "review_artifact",
      interactionId: "review:draft_email",
      artifactId: "draft_email",
      rendererRef: "canvas.email",
      editable: true,
      producerNodeId: "email_writer",
      outputText: "Subject: Sprint update\n\nDraft body ready for review.",
    })],
  });
  assert.equal(view.blocks[0]?.surface, "review.email");
  assert.equal(view.meta?.renderTarget, "canvas.email");
  assert.equal(view.meta?.canvasArtifactKey, "draft_email:canvas.email");
  assert.deepEqual(view.actions.map((action) => action.command), ["reject", "revise", "approve"]);
});

test("typed memory curation projects review.memories surface", () => {
  const view = projectOperatorView({
    status: "waiting_for_interaction",
    interactions: [{
      id: "interaction-memory",
      interaction_kind: "review_artifact",
      status: "pending",
      payload_json: {
        gateType: "memory_confirmation",
        items: [{ id: "mem_1", excerpt: "Sprint notes", include: true }],
        operatorInteraction: {
          kind: "review_artifact",
          interactionId: "review:memory_output",
          artifactId: "memory_output",
          rendererRef: null,
          editable: false,
          producerNodeId: "memory_searcher",
          outputText: "Memory candidates ready.",
        },
      },
    }],
  });
  assert.equal(view.blocks[0]?.surface, "review.memories");
});

test("missing typed state fails projection", () => {
  assert.throws(() => projectOperatorView({
    status: "waiting_for_interaction",
    interactions: [{
      id: "invalid",
      interaction_kind: "collect_input",
      status: "pending",
      payload_json: {},
    }],
  }), /missing valid typed operator state/);
});
