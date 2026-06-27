import assert from "node:assert/strict";
import test from "node:test";

import { deriveLoopNameFromPrompt } from "../../../src/loops/loop-name.js";

test("deriveLoopNameFromPrompt uses the first sentence and strips filler", () => {
  assert.equal(
    deriveLoopNameFromPrompt("I want to auto-reply to support tickets with context-aware drafts."),
    "Auto-reply to support tickets with context-aware drafts",
  );
});

test("deriveLoopNameFromPrompt truncates long prompts at a word boundary", () => {
  const name = deriveLoopNameFromPrompt(
    "Every morning summarize unread Gmail threads, extract action items, and post a digest to the #ops Slack channel",
  );
  assert.ok(name.length <= 60);
  assert.match(name, /^Every morning summarize unread Gmail threads/i);
});

test("deriveLoopNameFromPrompt falls back for empty input", () => {
  assert.equal(deriveLoopNameFromPrompt("   "), "New loop");
});
