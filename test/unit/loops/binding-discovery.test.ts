import assert from "node:assert/strict";
import test from "node:test";

import {
  BINDING_AMBIGUITY_SCORE_GAP,
  buildAmbiguityAskOptions,
  isAmbiguousBindingChoice,
  MIN_CAPABILITY_SCORE,
  outcomeFramedOptionLabel,
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
    capability: overrides.capability ?? "email.send",
    actionSlug: overrides.actionSlug,
    name: overrides.name ?? overrides.actionSlug,
    description: overrides.description ?? "",
    score: overrides.score,
    schemaSummary: overrides.schemaSummary ?? { required: [], properties: [] },
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

test("isAmbiguousBindingChoice is true when top scores are within the gap", () => {
  const sendVsDraft = [
    candidate({ actionSlug: "GMAIL_SEND_EMAIL", score: MIN_CAPABILITY_SCORE + 2 }),
    candidate({ actionSlug: "GMAIL_CREATE_DRAFT", score: MIN_CAPABILITY_SCORE + 2 - BINDING_AMBIGUITY_SCORE_GAP }),
  ];
  assert.equal(isAmbiguousBindingChoice(sendVsDraft), true);

  const clearWinner = [
    candidate({ actionSlug: "GMAIL_SEND_EMAIL", score: MIN_CAPABILITY_SCORE + 5 }),
    candidate({ actionSlug: "GMAIL_CREATE_DRAFT", score: MIN_CAPABILITY_SCORE }),
  ];
  assert.equal(isAmbiguousBindingChoice(clearWinner), false);
});

test("isAmbiguousBindingChoice is false for fetch-by-id vs inbox search (auto-resolve)", () => {
  const readVariants = [
    candidate({ actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", score: MIN_CAPABILITY_SCORE + 2 }),
    candidate({ actionSlug: "GMAIL_FETCH_EMAILS_WITH_FILTERS", score: MIN_CAPABILITY_SCORE + 2 }),
  ];
  assert.equal(isAmbiguousBindingChoice(readVariants), false);
});

test("pickRecommendedBinding prefers single-message read for event-driven outcomes", () => {
  const candidates = [
    candidate({ actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", score: 4 }),
    candidate({ actionSlug: "GMAIL_FETCH_EMAILS_WITH_FILTERS", score: 4 }),
  ];
  const picked = pickRecommendedBinding(candidates, "read the incoming support ticket that triggered the event");
  assert.equal(picked?.actionSlug, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
});

test("pickRecommendedBinding prefers batch read when outcome mentions search", () => {
  const candidates = [
    candidate({ actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", score: 4 }),
    candidate({ actionSlug: "GMAIL_FETCH_EMAILS_WITH_FILTERS", score: 4 }),
  ];
  const picked = pickRecommendedBinding(candidates, "search inbox for unresolved tickets");
  assert.equal(picked?.actionSlug, "GMAIL_FETCH_EMAILS_WITH_FILTERS");
});

test("outcomeFramedOptionLabel prefers business wording over raw slugs", () => {
  assert.match(
    outcomeFramedOptionLabel(candidate({ actionSlug: "GMAIL_CREATE_DRAFT", score: 3 })),
    /draft/i,
  );
  assert.match(
    outcomeFramedOptionLabel(candidate({ actionSlug: "GMAIL_SEND_EMAIL", score: 3 })),
    /send/i,
  );
});

test("buildAmbiguityAskOptions uses plain-language descriptions without action slugs", () => {
  const options = buildAmbiguityAskOptions([
    candidate({
      actionSlug: "GMAIL_SEND_EMAIL",
      capability: "email.send",
      score: 4,
      description: "Send an email",
    }),
    candidate({
      actionSlug: "GMAIL_CREATE_DRAFT",
      capability: "email.draft",
      score: 3,
      description: "Create draft",
    }),
  ]);
  assert.equal(options.length, 2);
  assert.equal(options[0]?.value, "email.send");
  assert.doesNotMatch(options[0]?.description ?? "", /GMAIL_/);
  assert.match(options[0]?.description ?? "", /right away|draft/i);
});
