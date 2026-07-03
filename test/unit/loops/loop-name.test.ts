import assert from "node:assert/strict";
import test from "node:test";

import { deriveLoopNameFromPrompt } from "../../../src/loops/loop-name.js";

test("deriveLoopNameFromPrompt compresses multi-step procedural prompts", () => {
  assert.equal(
    deriveLoopNameFromPrompt(
      "Classify incoming support tickets by priority, draft personalized replies, and send them after review.",
    ),
    "Support ticket helper",
  );
});

test("deriveLoopNameFromPrompt uses the first sentence and strips filler", () => {
  assert.equal(
    deriveLoopNameFromPrompt("I want to auto-reply to support tickets with context-aware drafts."),
    "Support ticket replies",
  );
});

test("deriveLoopNameFromPrompt shortens long event-driven prompts", () => {
  assert.equal(
    deriveLoopNameFromPrompt(
      "When a support ticket arrives, classify it by priority and create a reply draft for my review before anything is sent.",
    ),
    "Support ticket helper",
  );
});

test("deriveLoopNameFromPrompt keeps concise prompts readable", () => {
  assert.equal(deriveLoopNameFromPrompt("Weekly team digest"), "Weekly Team Digest");
});

test("deriveLoopNameFromPrompt handles digest prompts", () => {
  assert.equal(
    deriveLoopNameFromPrompt(
      "Every morning summarize unread Gmail threads, extract action items, and post a digest to the #ops Slack channel",
    ),
    "Morning inbox digest",
  );
});

test("deriveLoopNameFromPrompt handles lead follow-up prompts", () => {
  assert.equal(
    deriveLoopNameFromPrompt(
      "When a new lead comes in, research them and draft a personalized follow-up email for my review before sending.",
    ),
    "Lead follow-up",
  );
});

test("deriveLoopNameFromPrompt truncates long prompts at a word boundary", () => {
  const name = deriveLoopNameFromPrompt(
    "Every morning summarize unread Gmail threads, extract action items, and post a digest to the #ops Slack channel with extra detail",
  );
  assert.ok(name.length <= 48);
});

test("deriveLoopNameFromPrompt falls back for empty input", () => {
  assert.equal(deriveLoopNameFromPrompt("   "), "New loop");
});
