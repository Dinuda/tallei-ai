import assert from "node:assert/strict";
import test from "node:test";

import { projectRunWorkspace } from "../../../src/services/loop-runtime/run-workspace-projection.js";

test("recipient_upload gate shows contacts only", () => {
  const blocks = projectRunWorkspace({
    status: "waiting_for_gate",
    pendingGate: { gate_type: "recipient_upload", status: "pending" },
    gateUiMode: "recipient_upload",
  });
  assert.deepEqual(blocks, [{ type: "contacts_upload", required: true }]);
});

test("pre_send with dedicated recipient flow shows draft only", () => {
  const blocks = projectRunWorkspace({
    status: "waiting_for_gate",
    pendingGate: {
      gate_type: "pre_send",
      status: "pending",
      payload_json: { recipientStatus: "ready", uiBlocks: [] },
    },
    gateUiMode: "pre_send",
    context: { deliveryRecipients: { recipientCount: 3, contacts: [{ email: "a@b.com" }] } },
  });
  assert.deepEqual(blocks, [{ type: "draft_review" }]);
});

test("legacy pre_send with missing recipients shows contacts only first", () => {
  const blocks = projectRunWorkspace({
    status: "waiting_for_gate",
    pendingGate: {
      gate_type: "pre_send",
      status: "pending",
      payload_json: {
        recipientStatus: "missing",
        uiBlocks: [{ type: "contacts_upload", required: true }],
      },
    },
    gateUiMode: "pre_send",
  });
  assert.deepEqual(blocks, [{ type: "contacts_upload", required: true }]);
});
