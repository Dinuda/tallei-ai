import assert from "node:assert/strict";
import test from "node:test";

import { projectOperatorView } from "../../../src/services/loop-runtime/operator-view.js";
import {
  buildApprovalCheckpoint,
  buildRequirementCheckpoint,
  checkpointPayload,
  classifyOperatorCheckpoint,
  resolveOperatorCheckpointContinuation,
} from "../../../src/services/loop-runtime/operator-checkpoint.js";

test("run_start checkpoint projects input.markdown only", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    gates: [{
      id: "gate-1",
      gate_type: "missing_input",
      status: "pending",
      question: "Provide sprint notes.",
      payload_json: {
        when: "run_start",
        checkpoint: {
          reason: "missing_requirements",
          surfaces: [{
            key: "sprint_notes",
            surface: "input.markdown",
            required: true,
            satisfied: false,
            label: "Sprint Notes",
          }],
        },
        surfaces: [{
          key: "sprint_notes",
          surface: "input.markdown",
          required: true,
          satisfied: false,
          label: "Sprint Notes",
        }],
      },
    }],
  });
  assert.equal(view.blocks.length, 1);
  assert.equal(view.blocks[0]?.surface, "input.markdown");
  assert.deepEqual(view.actions, ["submit"]);
  assert.equal(view.workspace.title, "Sprint Notes");
});

test("source confirmation projects review.sources with approval actions", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    gates: [{
      id: "gate-2",
      gate_type: "source_confirmation",
      status: "pending",
      question: "Confirm sources",
      payload_json: {
        checkpoint: {
          reason: "review",
          surfaces: [{
            key: "approved_sources",
            surface: "review.sources",
            required: true,
            satisfied: false,
          }],
        },
        surfaces: [{
          key: "approved_sources",
          surface: "review.sources",
          required: true,
          satisfied: false,
        }],
        items: [{ id: "u1", title: "Example", url: "https://example.com", snippet: "text" }],
      },
    }],
  });
  assert.equal(view.blocks[0]?.surface, "review.sources");
  assert.deepEqual(view.actions, ["reject", "revise", "approve"]);
  assert.equal(view.workspace.stamp.name, "Sources");
});

test("explicit preview checkpoint projects a read-only preview surface", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    gates: [{
      id: "gate-preview",
      gate_type: "draft_review",
      status: "pending",
      payload_json: checkpointPayload({
        checkpoint: buildApprovalCheckpoint({
          gateType: "draft_review",
          surface: "review.preview",
          props: { renderTarget: "canvas.preview", canvasArtifactKey: "final:canvas.preview" },
        }),
        extra: {
          renderTarget: "canvas.preview",
          canvasArtifactKey: "final:canvas.preview",
          result: { text: "Subject: Final preview\n\nBody" },
        },
      }),
    }],
  });

  assert.equal(view.blocks[0]?.surface, "review.preview");
  assert.equal(view.meta?.renderTarget, "canvas.preview");
  assert.deepEqual(view.actions, ["reject", "revise", "approve"]);
});

test("legacy draft review with structured web sources projects an editable source checklist", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    gates: [{
      id: "gate-legacy-search",
      gate_type: "draft_review",
      status: "pending",
      question: "Review result",
      payload_json: {
        result: {
          text: "Serialized search output",
          data: {
            sources: [{ id: "u1", title: "Example", url: "https://example.com", snippet: "text" }],
          },
        },
      },
    }],
  });
  assert.equal(view.blocks[0]?.surface, "review.sources");
  assert.equal((view.blocks[0]?.data as { items: unknown[] }).items.length, 1);
  assert.equal(view.workspace.stamp.name, "Sources");
});

test("run_start and source review never mix without explicit checkpoint", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    gates: [{
      id: "gate-3",
      gate_type: "source_confirmation",
      status: "pending",
      payload_json: {
        checkpoint: {
          reason: "review",
          surfaces: [{
            key: "approved_sources",
            surface: "review.sources",
            required: true,
            satisfied: false,
          }],
        },
        surfaces: [{
          key: "approved_sources",
          surface: "review.sources",
          required: true,
          satisfied: false,
        }],
        items: [],
      },
    }],
  });
  assert.equal(view.blocks.some((block) => block.surface === "input.markdown"), false);
});

test("failed run missing recipients projects contacts surface without gate", () => {
  const view = projectOperatorView({
    status: "failed",
    errorMessage: "Delivery requires at least one recipient",
    gates: [],
  });
  assert.equal(view.gateId, null);
  assert.equal(view.blocks[0]?.surface, "input.contacts_csv");
  assert.deepEqual(view.actions, ["submit"]);
});

test("saved recipient checkpoint stays satisfied instead of re-synthesizing upload block", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    context: {
      deliveryRecipients: {
        contacts: [{ email: "alice@example.com" }],
        recipientCount: 1,
      },
    },
    gates: [{
      id: "gate-recipients",
      gate_type: "recipient_upload",
      status: "pending",
      question: "Add recipients.",
      payload_json: {
        recipientStatus: "ready",
        checkpoint: {
          reason: "missing_requirements",
          surfaces: [{
            key: "recipients",
            surface: "input.contacts_csv",
            required: true,
            satisfied: true,
            label: "Recipients",
          }],
        },
        surfaces: [{
          key: "recipients",
          surface: "input.contacts_csv",
          required: true,
          satisfied: true,
          label: "Recipients",
        }],
      },
    }],
  });
  assert.equal(view.blocks.length, 1);
  assert.equal(view.blocks[0]?.surface, "input.contacts_csv");
  assert.equal(view.blocks[0]?.satisfied, true);
  assert.deepEqual(view.actions, ["submit"]);
});

test("run_start input checkpoint is satisfied from existing context input", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    context: {
      inputs: {
        sprint_notes: "Completed: persistence shipped. In Progress: workspace isolation. Blockers: none. Next: polish.",
      },
    },
    gates: [{
      id: "gate-input",
      gate_type: "missing_input",
      status: "pending",
      question: "Provide sprint notes.",
      payload_json: {
        when: "run_start",
        checkpoint: {
          reason: "missing_requirements",
          surfaces: [{
            key: "sprint_notes",
            surface: "input.markdown",
            required: true,
            satisfied: false,
            label: "Sprint Notes",
          }],
        },
        surfaces: [{
          key: "sprint_notes",
          surface: "input.markdown",
          required: true,
          satisfied: false,
          label: "Sprint Notes",
        }],
      },
    }],
  });
  assert.equal(view.blocks.length, 1);
  assert.equal(view.blocks[0]?.surface, "input.markdown");
  assert.equal(view.blocks[0]?.satisfied, true);
  assert.deepEqual(view.actions, ["submit"]);
});

test("stale review input checkpoint is satisfied from existing context input", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    context: {
      inputs: {
        review: "Sprint Goal: improve persistence. Completed storage APIs. Next: harden workspace isolation.",
      },
    },
    gates: [{
      id: "gate-review",
      gate_type: "missing_input",
      status: "pending",
      question: "Provide review notes.",
      payload_json: {
        checkpoint: {
          reason: "review",
          surfaces: [{
            key: "review",
            surface: "input.markdown",
            required: true,
            satisfied: false,
          }],
        },
        surfaces: [{
          key: "review",
          surface: "input.markdown",
          required: true,
          satisfied: false,
        }],
      },
    }],
  });
  assert.equal(view.blocks[0]?.surface, "input.markdown");
  assert.equal(view.blocks[0]?.satisfied, true);
  assert.deepEqual(view.actions, ["submit"]);
});

test("missing_input gate synthesizes input.markdown block", () => {
  const view = projectOperatorView({
    status: "waiting_for_gate",
    gates: [{
      id: "gate-4",
      gate_type: "missing_input",
      status: "pending",
      question: "Paste sprint notes",
      payload_json: {},
    }],
  });
  assert.equal(view.blocks[0]?.surface, "input.markdown");
});

test("checkpoint reason, not legacy gate type, classifies every approval gate", () => {
  for (const gateType of [
    "missing_input",
    "memory_confirmation",
    "source_confirmation",
    "draft_review",
    "pre_send",
  ]) {
    const payload = checkpointPayload({
      checkpoint: buildApprovalCheckpoint({ gateType }),
    });
    assert.equal(classifyOperatorCheckpoint(payload), "approval", gateType);
  }

  const requirementPayload = checkpointPayload({
    checkpoint: buildRequirementCheckpoint({
      requirements: [{
        key: "recipients",
        surface: "input.contacts_csv",
        required: true,
        when: "before_send",
      }],
    }),
  });
  assert.equal(classifyOperatorCheckpoint(requirementPayload), "requirement");
  assert.equal(classifyOperatorCheckpoint({}), "unknown");
});

test("approval gates and completed run-start collectors advance; blocking requirements retry", () => {
  const reviewPayload = checkpointPayload({
    checkpoint: buildApprovalCheckpoint({ gateType: "missing_input" }),
  });
  assert.equal(resolveOperatorCheckpointContinuation({
    payload: reviewPayload,
    legacyRequirementGate: true,
    runStartInputCollector: true,
  }), "complete_step");

  const runStartPayload = {
    when: "run_start",
    ...checkpointPayload({
      checkpoint: buildRequirementCheckpoint({
        requirements: [{
          key: "sprint_notes",
          surface: "input.markdown",
          required: true,
          when: "run_start",
        }],
      }),
    }),
  };
  assert.equal(resolveOperatorCheckpointContinuation({
    payload: runStartPayload,
    legacyRequirementGate: false,
    runStartInputCollector: true,
  }), "complete_step");

  const beforeSendPayload = {
    when: "before_send",
    ...checkpointPayload({
      checkpoint: buildRequirementCheckpoint({
        requirements: [{
          key: "recipients",
          surface: "input.contacts_csv",
          required: true,
          when: "before_send",
        }],
      }),
    }),
  };
  assert.equal(resolveOperatorCheckpointContinuation({
    payload: beforeSendPayload,
    legacyRequirementGate: false,
    runStartInputCollector: false,
  }), "retry_step");
  assert.equal(resolveOperatorCheckpointContinuation({
    payload: {},
    legacyRequirementGate: true,
    runStartInputCollector: false,
  }), "retry_step");
});
