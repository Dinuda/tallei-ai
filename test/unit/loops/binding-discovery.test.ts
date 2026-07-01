import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_CAPABILITY_SCORE,
  pickRecommendedBinding,
  scoreOutcomeRelevance,
  selectExplicitBindingAction,
  type BindingCandidate,
} from "../../../src/loops/binding-discovery.js";

test("selectExplicitBindingAction uses the exact scoped action schema", () => {
  const result = selectExplicitBindingAction({
    connector: "generic",
    actionSlug: "GENERIC_EXACT_ACTION",
    scopedTools: [{
      actionSlug: "GENERIC_EXACT_ACTION",
      inputSchema: { required: ["record_id"] },
      outputSchema: { properties: { record: { type: "object" } } },
    }, {
      actionSlug: "GENERIC_DEFAULT_ACTION",
      inputSchema: {},
    }],
    globalMatches: [],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.actionSlug, "GENERIC_EXACT_ACTION");
    assert.deepEqual(result.action.inputSchema, { required: ["record_id"] });
  }
});

test("selectExplicitBindingAction distinguishes toolkit mismatch from missing action", () => {
  const mismatch = selectExplicitBindingAction({
    connector: "generic",
    actionSlug: "OTHER_EXACT_ACTION",
    scopedTools: [],
    globalMatches: [{ actionSlug: "OTHER_EXACT_ACTION", toolkit: "other" }],
  });
  const missing = selectExplicitBindingAction({
    connector: "generic",
    actionSlug: "GENERIC_MISSING_ACTION",
    scopedTools: [],
    globalMatches: [],
  });

  assert.deepEqual(mismatch, { ok: false, code: "ACTION_TOOLKIT_MISMATCH", actualToolkit: "other" });
  assert.deepEqual(missing, { ok: false, code: "ACTION_NOT_FOUND" });
});

function candidate(overrides: Partial<BindingCandidate> & Pick<BindingCandidate, "actionSlug" | "score">): BindingCandidate {
  return {
    capability: overrides.capability ?? overrides.actionSlug,
    actionSlug: overrides.actionSlug,
    name: overrides.name ?? overrides.actionSlug,
    description: overrides.description ?? "",
    score: overrides.score,
    schemaSummary: overrides.schemaSummary ?? { required: [], properties: [] },
    inputSchema: overrides.inputSchema ?? {},
  };
}

test("scoreOutcomeRelevance counts word overlap between outcome and action text", () => {
  const score = scoreOutcomeRelevance(
    "send reply to customer email",
    "GMAIL_SEND_EMAIL",
    "Send Email",
    "Sends an email message",
  );
  assert.ok(score > 0, "expected at least one word overlap");
});

test("scoreOutcomeRelevance returns 0 when no words match", () => {
  const score = scoreOutcomeRelevance(
    "publish blog post",
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "Get Message",
    "Fetch a Gmail message by its ID",
  );
  assert.equal(score, 0);
});

test("pickRecommendedBinding prefers single-message read for event-driven outcomes", () => {
  const candidates = [
    candidate({
      actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      score: 6,
      inputSchema: { required: ["message_id"], properties: { message_id: { type: "string" } } },
    }),
    candidate({
      actionSlug: "GMAIL_FETCH_EMAILS_WITH_FILTERS",
      score: 4,
      inputSchema: {
        properties: {
          query: { type: "string" },
          max_results: { type: "integer" },
        },
      },
    }),
  ];
  const picked = pickRecommendedBinding(
    candidates,
    { message_id: "abc" },
  );
  assert.equal(picked?.actionSlug, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
});

test("pickRecommendedBinding prefers trigger field overlap on ties", () => {
  const messageFetch = candidate({
    actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    score: 4,
    schemaSummary: { required: ["message_id"], properties: ["message_id"] },
    inputSchema: { required: ["message_id"], properties: { message_id: { type: "string" } } },
  });
  const filterFetch = candidate({
    actionSlug: "GMAIL_GET_FILTER_BY_ID",
    score: 4,
    schemaSummary: { required: ["filter_id"], properties: ["filter_id"] },
    inputSchema: { required: ["filter_id"], properties: { filter_id: { type: "string" } } },
  });
  const picked = pickRecommendedBinding(
    [filterFetch, messageFetch],
    { message_id: "abc" },
  );
  assert.equal(picked?.actionSlug, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
});
