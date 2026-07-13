import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import {
  ChatGptMemoryImportUseCase,
  parseChatGptImportInput,
} from "../../../src/orchestration/memory/chatgpt-import.usecase.js";
import type { ExtractHighSignalMemoriesOptions, ExtractHighSignalMemoriesResult } from "../../../src/orchestration/memory/chatgpt-import-extract.usecase.js";
import type { ScoredImportConversation } from "../../../src/orchestration/memory/chatgpt-import-signal.usecase.js";

const auth: AuthContext = {
  tenantId: "tenant-import",
  userId: "user-import",
  authMode: "internal",
  plan: "pro",
};

function mockExtractor(rows: ExtractHighSignalMemoriesResult["extracted"]) {
  return async (
    _conversations: ScoredImportConversation[],
    _options?: ExtractHighSignalMemoriesOptions
  ): Promise<ExtractHighSignalMemoriesResult> => ({
    extracted: rows,
    sentToExtractor: _conversations.length,
    warnings: [],
  });
}

test("parser handles JSON arrays and extracts datetime", () => {
  const arrayParsed = parseChatGptImportInput(JSON.stringify([
    "Use concise answers.",
    { memory: "My name is Dana.", datetime: "2026-05-20T09:00:00Z" },
  ]));

  assert.equal(arrayParsed.mode, "json_export");
  assert.equal(arrayParsed.items.length, 2);
  assert.equal(arrayParsed.invalid, 0);
  assert.equal(arrayParsed.items[1]?.sourceDateTime, "2026-05-20T09:00:00Z");
});

test("parser recovers JSON-like object lists that are not strict JSON", () => {
  const recovered = parseChatGptImportInput(`
    [
      {
        "memory":"User prefers short answers.",
        "datetime":"2026-03-06"
      },
      {
        "memory":"User is building Tallei memory index.",
        "datetime":"2026-04-06"
      },
    ]
  `);

  assert.equal(recovered.mode, "json_export");
  assert.equal(recovered.items.length, 2);
  assert.equal(recovered.items[0]?.sourceDateTime, "2026-03-06");
  assert.equal(recovered.items[1]?.sourceDateTime, "2026-04-06");
  assert.equal(recovered.invalid, 0);
});

test("use case dedupes and conflicts against existing values", async () => {
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
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.duplicates[0]?.reason, "exact_duplicate_existing");
  assert.equal(result.summary.persisted, 0);
});

test("parser routes Claude conversation exports through bulk pipeline", () => {
  const parsed = parseChatGptImportInput(JSON.stringify([
    {
      uuid: "conv-1",
      name: "Preferences",
      created_at: "2026-03-06T10:00:00.000Z",
      chat_messages: [
        { sender: "human", text: "I prefer concise answers for project updates.", created_at: "2026-03-06T10:00:01.000Z" },
        { sender: "assistant", text: "Got it.", created_at: "2026-03-06T10:00:02.000Z" },
      ],
    },
    {
      uuid: "conv-2",
      name: "Stack",
      created_at: "2026-04-06T10:00:00.000Z",
      chat_messages: [
        { sender: "human", text: "Our stack is TypeScript, Postgres, and Qdrant.", created_at: "2026-04-06T10:00:01.000Z" },
      ],
    },
  ]));

  assert.equal(parsed.mode, "claude_export");
  assert.equal(parsed.useBulkPipeline, true);
  assert.equal(parsed.bundles.length, 2);
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.importProfileOverride, "inclusive");
  assert.equal(parsed.invalid, 0);
  assert.match(parsed.bundles[0]?.messages[0]?.text ?? "", /concise answers/);
});

test("Claude export preview uses bulk extraction instead of raw chat lines", async () => {
  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [],
    persistMemory: async () => ({ memoryId: "mem-1" }),
    extractHighSignalMemories: mockExtractor([
      {
        memory: "User prefers concise answers for project updates.",
        type: "preference",
        stability: 0.9,
        reuseLikelihood: 0.9,
        confidence: 0.9,
        sourceReason: "Stable preference",
        sourceConversationId: "conv-1",
        sourceDateTime: "2026-03-06T10:00:00.000Z",
        sourceFile: "pasted-claude-export.json",
      },
    ]),
  });

  const result = await useCase.execute(auth, {
    input: JSON.stringify([{
      uuid: "conv-1",
      name: "Preferences",
      created_at: "2026-03-06T10:00:00.000Z",
      chat_messages: [
        { sender: "human", text: "I prefer concise answers for project updates and weekly reports.", created_at: "2026-03-06T10:00:01.000Z" },
      ],
    }]),
    apply: false,
  });

  assert.equal(result.mode, "claude_export");
  assert.equal(result.summary.parsed, 1);
  assert.equal(result.summary.extracted, 1);
  assert.equal(result.preview.length, 1);
  assert.match(result.preview[0]?.raw ?? "", /concise answers/);
  assert.equal(result.preview[0]?.extractType, "preference");
  assert.equal(result.importSource, "claude");
  assert.equal(result.warnings.some((warning) => warning.includes("strict JSON")), false);
});

test("Claude import persists with claude platform label", async () => {
  let persistedPlatform: string | null = null;
  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [],
    persistMemory: async ({ sourceImportPlatform }) => {
      persistedPlatform = sourceImportPlatform;
      return { memoryId: "mem-claude-1" };
    },
    extractHighSignalMemories: mockExtractor([
      {
        memory: "User prefers concise answers.",
        type: "preference",
        stability: 0.9,
        reuseLikelihood: 0.9,
        confidence: 0.9,
        sourceReason: "Stable preference",
        sourceConversationId: "conv-1",
        sourceDateTime: "2026-03-06T10:00:00.000Z",
        sourceFile: "pasted-claude-export.json",
      },
    ]),
  });

  await useCase.execute(auth, {
    input: JSON.stringify([{
      uuid: "conv-1",
      name: "Preferences",
      created_at: "2026-03-06T10:00:00.000Z",
      chat_messages: [
        { sender: "human", text: "I prefer concise answers for project updates.", created_at: "2026-03-06T10:00:01.000Z" },
      ],
    }]),
    importSource: "claude",
    apply: true,
  });

  assert.equal(persistedPlatform, "claude");
});

test("bulk_export pipeline filters junk and persists extracted memories only", async () => {
  const persisted: string[] = [];
  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [],
    persistMemory: async ({ content }) => {
      persisted.push(content);
      return { memoryId: `mem-${persisted.length}` };
    },
    extractHighSignalMemories: mockExtractor([
      {
        memory: "User is building Tallei, a memory layer for AI tools.",
        type: "project",
        stability: 0.9,
        reuseLikelihood: 0.9,
        confidence: 0.9,
        sourceReason: "Stable project fact",
        sourceConversationId: "good",
        sourceDateTime: "2024-02-01T00:00:00.000Z",
        sourceFile: "conversations.json",
      },
    ]),
  });

  const conversations = [
    {
      create_time: 1_760_000_000,
      mapping: {
        good: {
          id: "good",
          parent: null,
          children: [],
          message: {
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: ["I'm building Tallei, a memory layer for AI tools."],
            },
          },
        },
      },
    },
    {
      create_time: 1_760_000_010,
      mapping: {
        junk: {
          id: "junk",
          parent: null,
          children: [],
          message: {
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: [
                "how can i run it on android studio which file do i open in android",
              ],
            },
          },
        },
      },
    },
  ];

  const result = await useCase.execute(auth, {
    input: "",
    modeHint: "bulk_export",
    bulkDocuments: [{
      path: "conversations.json",
      role: "conversations",
      data: conversations,
    }],
    apply: true,
  });

  assert.equal(result.mode, "bulk_export");
  assert.equal(result.summary.parsed, 2);
  assert.equal(result.summary.keepHigh, 1);
  assert.equal(result.summary.extracted, 1);
  assert.equal(result.summary.accepted, 1);
  assert.equal(result.summary.persisted, 1);
  assert.equal(persisted.length, 1);
  assert.match(persisted[0] ?? "", /Tallei/);
  assert.equal(persisted.some((row) => /android studio/i.test(row)), false);
});

test("bulk_export preview returns extracted memories not raw chat lines", async () => {
  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [],
    persistMemory: async () => ({ memoryId: "mem-1" }),
  });

  const result = await useCase.execute(auth, {
    input: "",
    modeHint: "bulk_export",
    bulkDocuments: [{
      path: "conversations.json",
      role: "conversations",
      data: [{
        mapping: {
          pref: {
            id: "pref",
            parent: null,
            children: [],
            message: {
              author: { role: "user" },
              content: {
                content_type: "text",
                parts: ["I prefer concise answers for project updates and weekly reports."],
              },
            },
          },
        },
      }],
    }],
    apply: false,
  });

  assert.equal(result.preview.length, 1);
  assert.match(result.preview[0]?.raw ?? "", /concise answers/);
  assert.equal(result.preview[0]?.extractType, "preference");
});
