import assert from "node:assert/strict";
import test from "node:test";

import {
  computeOutcomeBriefHash,
  computeOutcomeReviewFingerprint,
  isOutcomeBriefConfirmed,
  isUserVisibleReviewUnchanged,
} from "../../../src/loops/outcome-brief.js";
import { applySpecPatch } from "../../../src/loops/patch.js";
import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("outcome confirmation requires the current spec hash", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.taskBlueprint = {
    version: 1,
    summary: "Support",
    outcomes: [
      { id: "source", role: "source", description: "Read tickets", selectedConnector: "zendesk", status: "chosen" },
      { id: "destination", role: "destination", description: "Notify support", selectedConnector: "slack", status: "chosen" },
    ],
  };
  const confirmed = applySpecPatch(spec, {
    intentDiscovery: { status: "confirmed", confirmedBriefHash: computeOutcomeBriefHash(spec) },
  });
  assert.equal(isOutcomeBriefConfirmed(confirmed), true);

  const edited = applySpecPatch(confirmed, { intent: { outcome: "A changed outcome" } });
  assert.equal(isOutcomeBriefConfirmed(edited), false);
  assert.equal(edited.intentDiscovery.confirmedBriefHash, undefined);
});

test("technical trigger slug normalization preserves confirmation when review is unchanged", () => {
  const spec = createEmptyLoopSpec(workspaceId);
  spec.intent = {
    goal: "Handle support mail",
    outcome: "Reply sent",
    successCriteria: [],
  };
  spec.taskBlueprint = {
    version: 1,
    summary: "Support reply",
    outcomes: [
      { id: "trigger", role: "trigger", description: "When a new support ticket arrives", selectedConnector: "gmail", status: "chosen" },
      { id: "send", role: "destination", description: "Send the email reply to the customer", selectedConnector: "gmail", status: "chosen" },
    ],
  };
  spec.trigger = { kind: "event", source: "gmail", eventType: "new_message", composioSlug: "GMAIL_NEW_GMAIL_MESSAGE", config: {} };
  spec.bindings = [
    { capability: "email.read", connector: "gmail", actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", role: "source" },
    { capability: "email.send", connector: "gmail", actionSlug: "GMAIL_REPLY_TO_THREAD", role: "destination" },
  ];
  spec.output = { kind: "none" };

  const confirmed = applySpecPatch(spec, {
    intentDiscovery: { status: "confirmed", confirmedBriefHash: computeOutcomeBriefHash(spec) },
  });
  assert.equal(isOutcomeBriefConfirmed(confirmed), true);

  const fingerprintBefore = computeOutcomeReviewFingerprint(confirmed);
  const normalized = applySpecPatch(confirmed, {
    trigger: {
      kind: "event",
      source: "gmail",
      eventType: "email.received",
      composioSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      config: {},
    },
    bindings: confirmed.bindings.map((binding) => ({
      ...binding,
      actionSlug: binding.actionSlug?.toLowerCase(),
    })),
  });

  assert.equal(computeOutcomeReviewFingerprint(normalized), fingerprintBefore);
  assert.equal(isUserVisibleReviewUnchanged(confirmed, normalized), true);
  assert.equal(isOutcomeBriefConfirmed(normalized), true);
});
