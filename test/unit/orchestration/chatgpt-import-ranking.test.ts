import assert from "node:assert/strict";
import test from "node:test";

import { selectTopImportCandidates } from "../../../src/orchestration/memory/chatgpt-import-ranking.usecase.js";

test("deterministic ranking keeps exact 30 percent with stable ordering", () => {
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    index,
    raw: `I prefer concise weekly project updates ${index}`,
    sourceDateTime: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    sourceFile: "conversations.json",
  }));

  const result = selectTopImportCandidates(candidates, 0.3);

  assert.equal(result.selectedCount, 3);
  assert.equal(result.skippedCount, 7);
  assert.equal(result.selectedIndices.length, 3);

  const unique = new Set(result.selectedIndices);
  assert.equal(unique.size, 3);
  assert.equal(result.selectedIndices[0], 9);
  assert.equal(result.selectedIndices[1], 8);
  assert.equal(result.selectedIndices[2], 7);
});

test("deterministic ranking handles empty inputs", () => {
  const result = selectTopImportCandidates([], 0.3);
  assert.equal(result.selectedCount, 0);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.selectedIndices, []);
});
