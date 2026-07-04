import assert from "node:assert/strict";
import test from "node:test";

import {
  pickRecommendedBinding,
  resolveBindingActionOverrides,
  scoreOutcomeRelevance,
  selectExplicitBindingAction,
  extractConfigurableFields,
  validateConfigAgainstSchema,
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

test("extractConfigurableFields keeps an optional Gmail label scope and ignores technical fields", () => {
  const schema = {
    type: "object",
    properties: {
      labelIds: { type: "array", title: "Gmail labels", description: "Only watch messages with these labels", items: { type: "string" } },
      webhookUrl: { type: "string", description: "Internal callback URL" },
    },
  };
  assert.deepEqual(extractConfigurableFields(schema).map((field) => field.key), ["labelIds"]);
  assert.deepEqual(validateConfigAgainstSchema(schema, { labelIds: ["INBOX"] }), { ok: true });
  assert.equal(validateConfigAgainstSchema(schema, { unknown: true }).ok, false);
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

test("resolveBindingActionOverrides rejects unknown, missing, and cross-toolkit actions", async () => {
  const result = await resolveBindingActionOverrides(
    "gmail",
    [{ id: "read" }, { id: "send" }],
    [
      { outcomeId: "transform", actionSlug: "GMAIL_SEND_EMAIL" },
      { outcomeId: "read", actionSlug: "GMAIL_MISSING" },
      { outcomeId: "send", actionSlug: "SLACK_SEND_MESSAGE" },
    ],
    async (_connector, actionSlug) => {
      if (actionSlug === "GMAIL_MISSING") return { ok: false, code: "ACTION_NOT_FOUND" } as const;
      if (actionSlug === "SLACK_SEND_MESSAGE") {
        return { ok: false, code: "ACTION_TOOLKIT_MISMATCH", actualToolkit: "slack" } as const;
      }
      return { ok: true, action: { actionSlug, inputSchema: {} } } as const;
    },
  );

  assert.equal(result.resolved.size, 0);
  assert.deepEqual(result.invalid, [
    { outcomeId: "transform", actionSlug: "GMAIL_SEND_EMAIL", code: "UNKNOWN_OUTCOME" },
    { outcomeId: "read", actionSlug: "GMAIL_MISSING", code: "ACTION_NOT_FOUND" },
    { outcomeId: "send", actionSlug: "SLACK_SEND_MESSAGE", code: "ACTION_TOOLKIT_MISMATCH", actualToolkit: "slack" },
  ]);
});

test("resolveBindingActionOverrides preserves validated provider action slugs", async () => {
  const result = await resolveBindingActionOverrides(
    "gmail",
    [{ id: "send" }],
    [{ outcomeId: "send", actionSlug: "GMAIL_REPLY_TO_THREAD" }],
    async () => ({
      ok: true,
      action: { actionSlug: "GMAIL_REPLY_TO_THREAD", inputSchema: {} },
    }),
  );

  assert.deepEqual([...result.resolved], [["send", "GMAIL_REPLY_TO_THREAD"]]);
  assert.deepEqual(result.invalid, []);
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
