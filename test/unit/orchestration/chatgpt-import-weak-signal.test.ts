import assert from "node:assert/strict";
import test from "node:test";

import { promoteWeakSignals } from "../../../src/orchestration/memory/chatgpt-import-weak-signal.usecase.js";
import type { ClassifiedImportConversations } from "../../../src/orchestration/memory/chatgpt-import-signal.usecase.js";

test("promoteWeakSignals promotes repeated rewrite requests", () => {
  const base: ClassifiedImportConversations = {
    parsedConversations: 4,
    parsedMessages: 4,
    hardDropped: 0,
    keepHigh: [],
    keepWeak: [],
    dropped: [
      {
        id: "1",
        sourceFile: "conversations.json",
        sourceDateTime: null,
        title: null,
        textBundle: "USER: make this shorter please",
        score: 0.1,
        disposition: "DROP",
        reasons: [],
        signalScores: {
          personal: 0,
          project: 0,
          preference: 0,
          decision: 0,
          workflow: 0,
          reuse: 0,
          junkPenalty: 0,
          assistantDurable: 0,
        },
      },
      {
        id: "2",
        sourceFile: "conversations.json",
        sourceDateTime: null,
        title: null,
        textBundle: "USER: can you make this shorter",
        score: 0.1,
        disposition: "DROP",
        reasons: [],
        signalScores: {
          personal: 0,
          project: 0,
          preference: 0,
          decision: 0,
          workflow: 0,
          reuse: 0,
          junkPenalty: 0,
          assistantDurable: 0,
        },
      },
      {
        id: "3",
        sourceFile: "conversations.json",
        sourceDateTime: null,
        title: null,
        textBundle: "USER: make it shorter for the email",
        score: 0.1,
        disposition: "DROP",
        reasons: [],
        signalScores: {
          personal: 0,
          project: 0,
          preference: 0,
          decision: 0,
          workflow: 0,
          reuse: 0,
          junkPenalty: 0,
          assistantDurable: 0,
        },
      },
    ],
    warnings: [],
  };

  const promoted = promoteWeakSignals(base);
  assert.equal(promoted.keepHigh.length, 1);
  assert.match(promoted.keepHigh[0]?.textBundle ?? "", /shorter/i);
});
