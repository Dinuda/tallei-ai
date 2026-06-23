import assert from "node:assert/strict";
import test from "node:test";

import { mergeSpecRunProjection } from "../../../src/services/conductor/runtime/spec-run-projection-merge.js";

test("mergeSpecRunProjection preserves optimistic interaction resolution during server lag", () => {
  const local = {
    status: "running",
    interactions: [{
      id: "ix-1",
      status: "approved",
      decision_json: { output: { ok: true } },
    }],
  };
  const server = {
    status: "waiting_for_interaction",
    interactions: [{
      id: "ix-1",
      status: "pending",
      decision_json: {},
    }],
  };

  const merged = mergeSpecRunProjection(local, server);

  assert.equal(merged.status, "running");
  assert.equal(merged.interactions?.[0]?.status, "approved");
});

test("mergeSpecRunProjection accepts fresh server state when no optimistic override exists", () => {
  const local = {
    status: "running",
    interactions: [{ id: "ix-1", status: "pending" }],
  };
  const server = {
    status: "succeeded",
    interactions: [{ id: "ix-1", status: "approved" }],
  };

  const merged = mergeSpecRunProjection(local, server);

  assert.equal(merged.status, "succeeded");
  assert.equal(merged.interactions?.[0]?.status, "approved");
});
