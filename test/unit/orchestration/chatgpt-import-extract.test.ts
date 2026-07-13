import assert from "node:assert/strict";
import test from "node:test";

import { mapExtractTypeToMemoryType } from "../../../src/orchestration/memory/chatgpt-import-extract.usecase.js";

test("mapExtractTypeToMemoryType maps storage types", () => {
  assert.deepEqual(mapExtractTypeToMemoryType("identity"), {
    memoryType: "preference",
    category: "identity",
  });
  assert.deepEqual(mapExtractTypeToMemoryType("technical"), {
    memoryType: "fact",
    category: "stack",
  });
  assert.deepEqual(mapExtractTypeToMemoryType("workflow"), {
    memoryType: "lesson",
    category: "workflow",
  });
});

test("mapExtractTypeToMemoryType defaults unknown types to fact", () => {
  assert.deepEqual(mapExtractTypeToMemoryType("other"), {
    memoryType: "fact",
    category: null,
  });
});
