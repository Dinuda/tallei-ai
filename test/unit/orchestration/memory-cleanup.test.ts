import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import type { MemoryRecordRow } from "../../../src/infrastructure/repositories/memory.repository.js";
import { BuildCleanupSnapshotUseCase } from "../../../src/orchestration/memory-cleanup/snapshot.usecase.js";
import { normalizeProposal, validateProposal } from "../../../src/orchestration/memory-cleanup/proposal-utils.js";

const auth: AuthContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  authMode: "internal",
  plan: "pro",
};

function row(overrides: Partial<MemoryRecordRow>): MemoryRecordRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tenant_id: auth.tenantId,
    user_id: auth.userId,
    content_ciphertext: "enc:one",
    content_hash: "hash-one",
    platform: "chatgpt",
    summary_json: {},
    qdrant_point_id: "00000000-0000-4000-8000-000000000001",
    memory_type: "fact",
    category: null,
    is_pinned: false,
    reference_count: 1,
    last_referenced_at: null,
    superseded_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

test("cleanup snapshot identifies duplicate, stale, conflict, and protected memories", async () => {
  const rows = [
    row({
      id: "00000000-0000-4000-8000-000000000001",
      content_ciphertext: "enc:duplicate-a",
      content_hash: "same-hash",
      created_at: "2025-01-01T00:00:00.000Z",
    }),
    row({
      id: "00000000-0000-4000-8000-000000000002",
      content_ciphertext: "enc:duplicate-b",
      content_hash: "same-hash",
      created_at: "2025-01-02T00:00:00.000Z",
    }),
    row({
      id: "00000000-0000-4000-8000-000000000003",
      content_ciphertext: "enc:preference-a",
      content_hash: "pref-a",
      memory_type: "preference",
      category: "ui",
      is_pinned: true,
      summary_json: { preference_key: "preference_ui" },
    }),
    row({
      id: "00000000-0000-4000-8000-000000000004",
      content_ciphertext: "enc:preference-b",
      content_hash: "pref-b",
      memory_type: "preference",
      category: "ui",
      is_pinned: true,
      summary_json: { preference_key: "preference_ui" },
    }),
  ];

  const useCase = new BuildCleanupSnapshotUseCase({
    listCandidateMemories: async () => rows,
    decryptMemoryContent: (ciphertext) => ciphertext.replace("enc:", "plain "),
  });

  const snapshot = await useCase.execute(auth, 200);

  assert.equal(snapshot.memoryCount, 4);
  assert.deepEqual(snapshot.duplicateGroups, [{
    contentHash: "same-hash",
    memoryIds: [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ],
  }]);
  assert.ok(snapshot.staleCandidateIds.includes("00000000-0000-4000-8000-000000000001"));
  assert.ok(snapshot.conflictCandidateIds.includes("00000000-0000-4000-8000-000000000003"));
  assert.ok(snapshot.protectedMemoryIds.includes("00000000-0000-4000-8000-000000000003"));
  assert.equal(snapshot.memories.find((memory) => memory.id === "00000000-0000-4000-8000-000000000003")?.bucket, "permanent");
  assert.equal(snapshot.memories.find((memory) => memory.id === "00000000-0000-4000-8000-000000000001")?.bucket, "long_term");
});

test("proposal validation rejects protected prune and malformed merge", () => {
  const snapshot = {
    memoryCount: 2,
    selectedMemoryIds: [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ],
    duplicateGroups: [],
    staleCandidateIds: [],
    conflictCandidateIds: [],
    protectedMemoryIds: ["00000000-0000-4000-8000-000000000001"],
    memories: [],
  };

  const prune = normalizeProposal({
    proposalType: "prune",
    sourceMemoryIds: ["00000000-0000-4000-8000-000000000001"],
    rationale: "old",
    confidence: 0.99,
    riskLevel: "low",
  });
  assert.ok(prune);
  assert.equal(validateProposal(prune, snapshot), "prune_protected_memory");

  const merge = normalizeProposal({
    proposalType: "merge",
    sourceMemoryIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
    targetMemoryId: "00000000-0000-4000-8000-000000000003",
    rationale: "same",
    confidence: 0.9,
    riskLevel: "medium",
  });
  assert.ok(merge);
  assert.equal(validateProposal(merge, snapshot), "unknown_target_memory_id");

  const protectedBucket = normalizeProposal({
    proposalType: "bucket",
    sourceMemoryIds: ["00000000-0000-4000-8000-000000000001"],
    bucket: "short_term",
    rationale: "temporary",
    confidence: 0.99,
    riskLevel: "low",
  });
  assert.ok(protectedBucket);
  assert.equal(validateProposal(protectedBucket, snapshot), "protected_memory_must_be_permanent");
});
