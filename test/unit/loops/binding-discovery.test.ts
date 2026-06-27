import assert from "node:assert/strict";
import test from "node:test";

import {
  BINDING_AMBIGUITY_SCORE_GAP,
  alignCapabilityWithAction,
  buildAmbiguityAskOptions,
  isAmbiguousBindingChoice,
  MIN_CAPABILITY_SCORE,
  outcomeFramedOptionLabel,
  pickRecommendedBinding,
  suggestCapabilityLabel,
  type BindingCandidate,
} from "../../../src/loops/binding-discovery.js";

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

test("suggestCapabilityLabel maps natural language outcomes to domain verbs", () => {
  assert.equal(suggestCapabilityLabel("read incoming support emails", "gmail"), "email.read");
  assert.equal(suggestCapabilityLabel("send replies to customers", "gmail"), "email.send");
  assert.equal(suggestCapabilityLabel("apply priority labels to tickets", "gmail"), "email.labels");
  assert.equal(suggestCapabilityLabel("create a draft for review", "gmail"), "email.draft");
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

test("alignCapabilityWithAction maps email.read to email.get for fetch-by-id", () => {
  const schema = {
    type: "object",
    required: ["message_id"],
    properties: { message_id: { type: "string" } },
  };
  assert.equal(
    alignCapabilityWithAction(
      "email.read",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      schema,
      "read incoming support emails",
    ),
    "email.get",
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
