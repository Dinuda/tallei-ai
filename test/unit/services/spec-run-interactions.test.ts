import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOperatorViewFromInteraction,
  mapInteractionKindForUi,
  patchMessagesWithToolResult,
} from "../../../src/services/loop-runtime/spec-run-interactions.js";

test("mapInteractionKindForUi prefers payload gateType", () => {
  const kind = mapInteractionKindForUi({
    id: "ix-1",
    run_id: "run-1",
    step_attempt_id: "step-1",
    interaction_kind: "review_artifact",
    status: "pending",
    question: "Review draft",
    payload_json: { gateType: "draft_review" },
    decision_json: {},
  });
  assert.equal(kind, "draft_review");
});

test("buildOperatorViewFromInteraction exposes draft review workspace", () => {
  const view = buildOperatorViewFromInteraction({
    id: "ix-1",
    run_id: "run-1",
    step_attempt_id: "step-1",
    interaction_kind: "review_artifact",
    status: "pending",
    question: "Review the draft, then save & approve or request changes.",
    payload_json: {
      gateType: "draft_review",
      toolKey: "action_gmail_GMAIL_CREATE_EMAIL_DRAFT",
      canvasArtifactKey: "action_gmail_GMAIL_CREATE_EMAIL_DRAFT:canvas.email",
      deferred: {
        actionLabel: "Create Email Draft",
        payload: { subject: "Hello", body: "Draft body" },
      },
    },
    decision_json: {},
  }, { name: "Create Email Draft" });

  assert.ok(view);
  assert.equal(view?.interactionId, "ix-1");
  assert.equal(view?.blocks[0]?.surface, "review.email");
  assert.ok(view?.actions.some((action) => action.command === "approve"));
  assert.equal(view?.meta?.canvasArtifactKey, "action_gmail_GMAIL_CREATE_EMAIL_DRAFT:canvas.email");
});

test("buildOperatorViewFromInteraction does not infer email renderer without explicit render config", () => {
  const view = buildOperatorViewFromInteraction({
    id: "ix-preview",
    run_id: "run-1",
    step_attempt_id: "step-1",
    interaction_kind: "review_artifact",
    status: "pending",
    question: "Review output",
    payload_json: {
      gateType: "draft_review",
      toolKey: "classifier_output",
      deferred: {
        actionLabel: "Classify ticket",
        payload: { subject: "site down", priority: "high" },
      },
    },
    decision_json: {},
  }, { name: "Classifier" });

  assert.ok(view);
  assert.equal(view?.blocks[0]?.surface, "review.preview");
  assert.equal(view?.blocks[0]?.props, undefined);
  assert.equal(view?.meta?.canvasArtifactKey, undefined);
  assert.equal(view?.meta?.renderTarget, undefined);
});

test("buildOperatorViewFromInteraction preserves explicit builder-style interaction surfaces", () => {
  const view = buildOperatorViewFromInteraction({
    id: "ix-input",
    run_id: "run-1",
    step_attempt_id: "step-1",
    interaction_kind: "collect_input",
    status: "pending",
    question: "Provide tone",
    payload_json: {
      workspace: {
        title: "Input required",
        subtitle: "Provide tone",
        stamp: { tag: "Input", name: "Draft Writer" },
      },
      blocks: [{
        kind: "collect_input",
        id: "tone",
        surface: "input.text",
        required: true,
        satisfied: false,
        label: "Tone",
      }],
      actions: [{ id: "submit", command: "submit_input", label: "Submit input", enabled: true }],
      meta: { nextAgentName: "Draft Writer" },
    },
    decision_json: {},
  }, { name: "Draft Writer" });

  assert.equal(view?.workspace.title, "Input required");
  assert.equal(view?.blocks[0]?.kind, "collect_input");
  assert.equal(view?.blocks[0]?.surface, "input.text");
  assert.equal(view?.actions[0]?.command, "submit_input");
  assert.equal(view?.meta?.nextAgentName, "Draft Writer");
});

test("patchMessagesWithToolResult completes pending tool parts", () => {
  const patched = patchMessagesWithToolResult([
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-searchMemory",
        toolCallId: "call-1",
        state: "input-available",
        input: { query: "faq" },
      }],
    },
  ], "searchMemory", { sources: [] });

  const part = patched[0]?.parts[0] as { state?: string; output?: unknown };
  assert.equal(part.state, "output-available");
  assert.deepEqual(part.output, { sources: [] });
});
