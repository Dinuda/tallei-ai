import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import {
  ChatGptMemoryImportUseCase,
  parseChatGptImportInput,
} from "../../../src/orchestration/memory/chatgpt-import.usecase.js";

const auth: AuthContext = {
  tenantId: "tenant-import",
  userId: "user-import",
  authMode: "internal",
  plan: "pro",
};

test("parser handles JSON array strings and nested object preferences", () => {
  const arrayParsed = parseChatGptImportInput(JSON.stringify([
    "Use concise answers.",
    { memory: "My name is Dana.", datetime: "2026-05-20T09:00:00Z" },
  ]));
  assert.equal(arrayParsed.mode, "json_export");
  assert.equal(arrayParsed.items.length, 2);
  assert.equal(arrayParsed.invalid, 0);
  assert.equal(arrayParsed.items[1]?.sourceDateTime, "2026-05-20T09:00:00Z");

  const objectParsed = parseChatGptImportInput(JSON.stringify({
    preferences: [
      "My pronouns are she/her.",
      { value: "timezone: PST" },
      42,
    ],
  }));
  assert.equal(objectParsed.mode, "json_export");
  assert.equal(objectParsed.items.length, 2);
  assert.equal(objectParsed.invalid, 0);
});

test("parser handles key/value object and pasted line list", () => {
  const keyValueObject = parseChatGptImportInput(JSON.stringify({
    tone: "concise",
    format: "bullet points",
    misc: 7,
  }));
  assert.equal(keyValueObject.items.length, 2);
  assert.equal(keyValueObject.invalid, 0);
  assert.equal(keyValueObject.items[0]?.detectedKey, "tone");

  const pasted = parseChatGptImportInput(`
    - Use concise answers
    - Use concise answers
    1. [2026-05-20] My name is Dana
  `);
  assert.equal(pasted.mode, "paste");
  assert.equal(pasted.items.length, 3);
  assert.equal(pasted.items[2]?.sourceDateTime, "2026-05-20");
  assert.equal(pasted.items[2]?.raw, "My name is Dana");
});

test("use case accepts non-preference memories and dedupes intra-batch", async () => {
  const persisted: string[] = [];
  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [],
    persistMemory: async ({ content }) => {
      persisted.push(content);
      return { memoryId: `mem-${persisted.length}` };
    },
  });

  const result = await useCase.execute(auth, {
    input: JSON.stringify([
      "I prefer concise answers",
      "I prefer concise answers",
      "deploy failed due to timeout",
    ]),
    apply: false,
  });

  assert.equal(result.summary.parsed, 3);
  assert.equal(result.summary.accepted, 2);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.summary.persisted, 0);
  assert.equal(result.preview.length, 2); // accepted rows
  assert.equal(persisted.length, 0);
});

test("use case detects exact duplicate and contradictory conflicts against existing memories", async () => {
  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [
      {
        id: "existing-1",
        text: "I live in NYC",
        memoryType: "preference",
        preferenceKey: "identity_location",
        category: "identity",
      },
      {
        id: "existing-2",
        text: "I prefer concise answers",
        memoryType: "preference",
        preferenceKey: null,
        category: null,
      },
    ],
    persistMemory: async () => ({ memoryId: "created-1" }),
  });

  const result = await useCase.execute(auth, {
    input: JSON.stringify([
      "I live in SF",
      "I prefer concise answers",
      "My name is Dana",
    ]),
    apply: false,
  });

  assert.equal(result.summary.conflicts, 1);
  assert.equal(result.conflicts[0]?.reason, "contradictory_value");
  assert.equal(result.conflicts[0]?.existing.memoryId, "existing-1");
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.duplicates[0]?.reason, "exact_duplicate_existing");
  assert.ok(result.summary.accepted >= 1);
});

test("use case apply=true persists only accepted rows and tags source metadata path", async () => {
  const persisted: Array<{
    content: string;
    memoryType: string;
    category: string | null;
    isPinned: boolean;
    sourceDateTime: string | null;
    sourceImportMode: "json_export" | "paste";
    sourceImportBatchId: string;
    importEntityKey: string | null;
  }> = [];

  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [],
    persistMemory: async (input) => {
      persisted.push({
        content: input.content,
        memoryType: input.memoryType,
        category: input.category,
        isPinned: input.isPinned,
        sourceDateTime: input.sourceDateTime,
        sourceImportMode: input.sourceImportMode,
        sourceImportBatchId: input.sourceImportBatchId,
        importEntityKey: input.importEntityKey,
      });
      return { memoryId: `saved-${persisted.length}` };
    },
  });

  const result = await useCase.execute(auth, {
    input: JSON.stringify([
      { memory: "My name is Dana", datetime: "2026-05-20" },
      { memory: "My timezone is PST", datetime: null },
    ]),
    apply: true,
  });

  assert.equal(result.summary.accepted, 2);
  assert.equal(result.summary.persisted, 2);
  assert.equal(result.preview.length, 0);
  assert.equal(persisted.length, 2);
  assert.ok(persisted[0]?.sourceImportBatchId);
  assert.equal(persisted[0]?.sourceImportMode, "json_export");
  assert.equal(persisted[0]?.sourceDateTime, "2026-05-20");
  assert.equal(typeof persisted[0]?.memoryType, "string");
});
