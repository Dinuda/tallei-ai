import assert from "node:assert/strict";
import test from "node:test";

import { extractHighSignalImportMemoriesHeuristic } from "../../../src/orchestration/memory/chatgpt-import-heuristic-extract.usecase.js";
import type { ScoredImportConversation } from "../../../src/orchestration/memory/chatgpt-import-signal.usecase.js";

function conversation(
  id: string,
  textBundle: string,
  score = 0.7
): ScoredImportConversation {
  return {
    id,
    sourceFile: "conversations.json",
    sourceDateTime: "2024-02-01T00:00:00.000Z",
    title: null,
    textBundle,
    score,
    disposition: "KEEP_HIGH",
    reasons: ["project"],
    signalScores: {
      personal: 1,
      project: 1,
      preference: 0,
      decision: 0,
      workflow: 0,
      reuse: 1,
      junkPenalty: 0,
      assistantDurable: 0,
    },
  };
}

test("heuristic extractor promotes high-signal user lines without LLM", async () => {
  const result = await extractHighSignalImportMemoriesHeuristic([
    conversation(
      "tallei",
      "USER: I'm building Tallei, a memory layer for AI tools."
    ),
  ]);

  assert.equal(result.extracted.length, 1);
  assert.match(result.extracted[0]?.memory ?? "", /Tallei/i);
  assert.equal(result.extracted[0]?.type, "project");
  assert.match(result.warnings.join(" "), /no LLM/i);
});

test("heuristic extractor skips low-signal user lines inside KEEP_HIGH bundles", async () => {
  const result = await extractHighSignalImportMemoriesHeuristic([
    conversation(
      "noise",
      "USER: thanks for the help there"
    ),
  ]);

  assert.equal(result.extracted.length, 0);
});

test("heuristic extractor includes confirmed assistant architecture content", async () => {
  const result = await extractHighSignalImportMemoriesHeuristic([
    conversation(
      "arch",
      [
        "USER: Can you draft our system design?",
        "ASSISTANT: Proposed architecture: Next.js dashboard, Express MCP server, Postgres pgvector store.",
        "USER: Sounds good, let's go with that stack.",
      ].join("\n")
    ),
  ]);

  assert.ok(result.extracted.length >= 1);
  assert.ok(result.extracted.some((row) => /architecture|pgvector|Next\.js/i.test(row.memory)));
});
