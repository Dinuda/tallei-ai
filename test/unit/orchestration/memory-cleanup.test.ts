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

test("cleanup snapshot hybrid selection keeps newest memories and older action memories", async () => {
  const rows = Array.from({ length: 8 }, (_, index) => row({
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    content_ciphertext: `enc:low-signal-${index}`,
    content_hash: `hash-${index}`,
    memory_type: "note",
    category: "profile",
    importance: "0.1000",
    created_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  rows.unshift(row({
    id: "00000000-0000-4000-8000-000000000199",
    content_ciphertext: "enc:Every Friday I review analytics and draft the customer newsletter.",
    content_hash: "hash-interesting",
    memory_type: "fact",
    category: "workflow",
    importance: "0.9000",
    summary_json: { source_import: true, import_detected_memory_type: "workflow" },
    created_at: "2025-01-01T00:00:00.000Z",
  }));

  const useCase = new BuildCleanupSnapshotUseCase({
    listCandidateMemories: async (_auth, input) => {
      assert.equal(input.selectionStrategy, "newest_hybrid");
      return rows;
    },
    decryptMemoryContent: (ciphertext) => ciphertext.replace("enc:", ""),
  });

  const snapshot = await useCase.execute(auth, 5, false, [], {
    strategy: "newest_hybrid",
    newestLimit: 3,
    interestingLimit: 2,
  });

  assert.equal(snapshot.memoryCount, 4);
  assert.equal(snapshot.selection?.newestSelected, 3);
  assert.equal(snapshot.selection?.interestingSelected, 1);
  assert.ok(snapshot.selectedMemoryIds.includes("00000000-0000-4000-8000-000000000199"));
  assert.deepEqual(snapshot.selectedMemoryIds.slice(0, 3), [
    "00000000-0000-4000-8000-000000000107",
    "00000000-0000-4000-8000-000000000106",
    "00000000-0000-4000-8000-000000000105",
  ]);
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
