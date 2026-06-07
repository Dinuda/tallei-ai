import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import type { MemoryRecordRow } from "../../../src/infrastructure/repositories/memory.repository.js";
import { runCuratedMemorySearch } from "../../../src/services/loop-runtime/curated-memory-search.js";

const auth: AuthContext = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authMode: "internal",
  plan: "pro",
};

function row(input: {
  id: string;
  text: string;
  memoryType?: string;
  category?: string | null;
  createdAt?: string;
}): MemoryRecordRow {
  return {
    id: input.id,
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    content_ciphertext: input.text,
    content_hash: input.id,
    platform: "chatgpt",
    summary_json: {},
    qdrant_point_id: input.id,
    memory_type: input.memoryType ?? "fact",
    category: input.category ?? null,
    is_pinned: false,
    reference_count: 1,
    tier: "long_term",
    segment: null,
    importance: 0.6,
    decay_rate: 0.01,
    access_count: 1,
    lifecycle: "active",
    last_referenced_at: null,
    superseded_by: null,
    created_at: input.createdAt ?? new Date().toISOString(),
    deleted_at: null,
  };
}

function makeDeps(rows: MemoryRecordRow[], validationAcceptedIds: string[]) {
  let chatCalls = 0;
  return {
    memoryRepository: {
      listAll: async () => rows,
      getByIds: async (_inputAuth: AuthContext, ids: string[]) =>
        rows.filter((candidate) => ids.includes(candidate.id)),
    },
    vectorRepository: {
      searchVectors: async () => rows.map((candidate, index) => ({
        memoryId: candidate.id,
        pointId: candidate.qdrant_point_id,
        score: Math.max(0.1, 0.95 - index * 0.1),
      })),
    },
    embedText: async () => [0.1, 0.2, 0.3],
    decryptMemoryContent: (value: string) => value,
    chat: async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          text: JSON.stringify({
            intent: "internal product sync for Tallei",
            outputType: "internal_sync_email",
            entities: ["Tallei", "product sync", "sprint"],
            dateHints: ["this week"],
            queries: [
              "Tallei product sync sprint shipped this week",
              "Tallei customer-facing blog post product updates",
              "Tallei in progress blockers things to watch",
            ],
            requiredEvidence: ["past product updates", "customer-facing changes"],
          }),
          model: "test",
          finishReason: "stop",
          usage: null,
        };
      }
      return {
        text: JSON.stringify({
          accepted: validationAcceptedIds.map((id) => ({
            id,
            excerpt: rows.find((candidate) => candidate.id === id)?.content_ciphertext ?? id,
            reason: "Directly describes a product update for this sync.",
            evidenceRole: "past_update",
            confidence: 0.92,
          })),
          rejectedIds: rows.map((candidate) => candidate.id).filter((id) => !validationAcceptedIds.includes(id)),
          confidence: validationAcceptedIds.length > 0 ? "high" : "none",
          noEvidenceReason: validationAcceptedIds.length > 0 ? undefined : "No candidate directly supports the requested output.",
        }),
        model: "test",
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

test("curated memory search returns only validated task-relevant memories", async () => {
  const sprint = row({
    id: "11111111-1111-4111-8111-111111111111",
    text: "Tallei shipped memory deduplication and context handoff improvements for this week's product sync.",
    category: "product",
  });
  const personal = row({
    id: "22222222-2222-4222-8222-222222222222",
    text: "Airbnb guest asked to store meat in a downstairs refrigerator.",
    category: "personal",
  });

  const result = await runCuratedMemorySearch({
    auth,
    goal: "Write an internal product sync email for Tallei engineering and ops.",
    agent: {
      id: "memory_search",
      name: "Memory Search Agent",
      task: "Find memories for this week's Tallei product update.",
      tools: [{ ref: "internal.memory_search" }],
    },
    configuredQuery: "Tallei product sync sprint updates",
  }, makeDeps([sprint, personal], [sprint.id]));

  assert.equal(result.confidence, "high");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.id, sprint.id);
  assert.equal(result.sources[0]?.evidenceRole, "past_update");
  assert.equal(result.rejectedCount, 1);
});

test("curated memory search returns no sources when validation rejects all candidates", async () => {
  const personal = row({
    id: "33333333-3333-4333-8333-333333333333",
    text: "Guest asked about apartment refrigerator storage.",
    category: "personal",
  });

  const result = await runCuratedMemorySearch({
    auth,
    goal: "Write an internal product sync email for Tallei engineering and ops.",
    agent: {
      id: "memory_search",
      name: "Memory Search Agent",
      task: "Find memories for this week's Tallei product update.",
      tools: [{ ref: "internal.memory_search" }],
    },
    configuredQuery: "Tallei product sync sprint updates",
  }, makeDeps([personal], []));

  assert.equal(result.confidence, "none");
  assert.equal(result.sources.length, 0);
  assert.match(result.noEvidenceReason ?? "", /No candidate directly supports/);
});
