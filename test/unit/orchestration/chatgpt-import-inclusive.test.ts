import assert from "node:assert/strict";
import test from "node:test";

import {
  bundlesToImportConversations,
  classifyBulkImportCandidates,
} from "../../../src/orchestration/memory/chatgpt-import-signal.usecase.js";
import type { BulkConversationBundle } from "../../../src/orchestration/memory/chatgpt-bulk-parser.js";
import { isConversationWithinImportWindow } from "../../../src/orchestration/memory/chatgpt-bulk-parser.js";
import { ChatGptMemoryImportUseCase } from "../../../src/orchestration/memory/chatgpt-import.usecase.js";
import type { ChatGptImportCandidate } from "../../../src/orchestration/memory/chatgpt-import.usecase.js";

function conversationBundle(text: string, id = "conv-1"): BulkConversationBundle {
  return {
    id,
    sourceFile: "conversations.json",
    sourceDateTime: "2024-01-01T00:00:00.000Z",
    title: "Test",
    messages: [{ role: "user", text }],
  };
}

test("inclusive hardDrop keeps email paste, UUID task prompts, assistant markdown, and creative prompts", () => {
  const samples = [
    "Please review this Gmail thread about pricing: inbox@company.com sent updates to team@company.com",
    "continue task 550e8400-e29b-41d4-a716-446655440000 with MCP tool prepare_response",
    "ASSISTANT: Here is the system architecture with modules for auth, billing, and ingestion pipeline.",
    "create 20 images of product mockups for the landing page hero section",
  ];

  for (const text of samples) {
    const classified = classifyBulkImportCandidates(
      bundlesToImportConversations([conversationBundle(text, text.slice(0, 12))]),
      { importProfile: "inclusive", keepHighThreshold: 0.05, keepWeakThreshold: 0.01 }
    );
    assert.ok(
      classified.keepHigh.length + classified.keepWeak.length > 0,
      `Expected inclusive keep for: ${text.slice(0, 60)}`
    );
  }
});

test("maxAgeDays null includes old conversations with valid mapping", () => {
  const oldConversation = {
    title: "old",
    create_time: Math.floor(Date.now() / 1000) - 86_400 * 600,
    current_node: "node_1",
    mapping: {
      node_1: {
        id: "node_1",
        parent: null,
        children: [],
        message: {
          id: "message_1",
          author: { role: "user" },
          content: { content_type: "text", parts: ["Old but valid conversation."] },
          create_time: Math.floor(Date.now() / 1000) - 86_400 * 600,
        },
      },
    },
  };

  assert.equal(isConversationWithinImportWindow(oldConversation, null), true);
  assert.equal(isConversationWithinImportWindow(oldConversation, 0), true);
});

test("persistImportPreview persists preview without re-classifying", async () => {
  const persistedTexts: string[] = [];
  const useCase = new ChatGptMemoryImportUseCase({
    listExistingMemories: async () => [],
    persistMemory: async ({ content }) => {
      persistedTexts.push(content);
      return { memoryId: `mem_${persistedTexts.length}` };
    },
  });

  const preview: ChatGptImportCandidate[] = [
    {
      raw: "Every Monday I prepare the weekly metrics report.",
      normalized: "every monday i prepare the weekly metrics report.",
      detectedKey: null,
      detectedValue: "every monday i prepare the weekly metrics report.",
      sourceDateTime: "2026-05-20",
      memoryType: "fact",
      category: "work",
      isPinned: false,
      preferenceKey: null,
      status: "accepted",
    },
  ];

  const result = await useCase.persistImportPreview(
    { tenantId: "t1", userId: "u1", authMode: "internal", plan: "free" },
    { preview, batchId: "batch-1", mode: "bulk_export", importSource: "chatgpt" }
  );

  assert.equal(result.persisted, 1);
  assert.equal(persistedTexts.length, 1);
  assert.match(persistedTexts[0]!, /weekly metrics report/);
});
