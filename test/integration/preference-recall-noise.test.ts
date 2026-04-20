import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.INTERNAL_API_SECRET ??= "integration-secret";
process.env.DATABASE_URL ??= "postgresql://tallei:tallei@127.0.0.1:5432/tallei";
process.env.DATABASE_URL_FALLBACK ??= process.env.DATABASE_URL;
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.JWT_SECRET ??= "integration-jwt-secret";
process.env.MEMORY_MASTER_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "";

type MemoryType = "preference" | "fact" | "event" | "decision" | "note";

interface MemoryFixture {
  id: string;
  tenant_id: string;
  user_id: string;
  content_ciphertext: string;
  content_hash: string;
  platform: string;
  summary_json: Record<string, unknown>;
  qdrant_point_id: string;
  memory_type: MemoryType;
  category: string | null;
  is_pinned: boolean;
  reference_count: number;
  last_referenced_at: string | null;
  superseded_by: string | null;
  created_at: string;
  deleted_at: string | null;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function jaccardSimilarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  const union = left.size + right.size - overlap;
  return union <= 0 ? 0 : overlap / union;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/embeddings")) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { input?: string } : {};
    const inputText = body.input ?? "";
    const tokens = tokenize(inputText);
    const vec = new Array(8).fill(0).map((_, index) => {
      const token = tokens[index % Math.max(tokens.length, 1)] ?? "";
      let hash = 0;
      for (let i = 0; i < token.length; i += 1) {
        hash = (hash * 31 + token.charCodeAt(i)) % 997;
      }
      return Number((hash / 997).toFixed(4));
    });
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: vec }],
        model: "text-embedding-3-small",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ error: `Unhandled fetch URL in test stub: ${url}` }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
};

const [{ randomUUID, createHash }, { encryptMemoryContent, decryptMemoryContent }, { MemoryRepository }, { VectorRepository }, { hybridRecall }] =
  await Promise.all([
    import("node:crypto"),
    import("../../src/infrastructure/crypto/memory-crypto.js"),
    import("../../src/infrastructure/repositories/memory.repository.js"),
    import("../../src/infrastructure/repositories/vector.repository.js"),
    import("../../src/infrastructure/recall/hybrid-retrieval.js"),
  ]);

const auth = {
  tenantId: "tenant-1",
  userId: "user-1",
  authMode: "api_key" as const,
  plan: "pro" as const,
};

const fixtures: MemoryFixture[] = [
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("My favorite color is blue."), content_hash: createHash("sha256").update("pref:color:blue").digest("hex"), platform: "claude", summary_json: { title: "Favorite color", preference_key: "favorite_color" }, qdrant_point_id: randomUUID(), memory_type: "preference", category: "identity", is_pinned: true, reference_count: 6, last_referenced_at: daysAgo(1), superseded_by: null, created_at: daysAgo(10), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("I prefer minimal UI with compact spacing."), content_hash: createHash("sha256").update("pref:ui:minimal").digest("hex"), platform: "claude", summary_json: { title: "UI preference", preference_key: "preference_ui" }, qdrant_point_id: randomUUID(), memory_type: "preference", category: "ui", is_pinned: true, reference_count: 5, last_referenced_at: daysAgo(3), superseded_by: null, created_at: daysAgo(12), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("My name is Alex."), content_hash: createHash("sha256").update("pref:name:alex").digest("hex"), platform: "claude", summary_json: { title: "Name", preference_key: "identity_name" }, qdrant_point_id: randomUUID(), memory_type: "preference", category: "identity", is_pinned: true, reference_count: 8, last_referenced_at: daysAgo(2), superseded_by: null, created_at: daysAgo(20), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Our preferred stack is TypeScript, Postgres, and Qdrant."), content_hash: createHash("sha256").update("pref:stack:ts-postgres-qdrant").digest("hex"), platform: "claude", summary_json: { title: "Stack preference", preference_key: "preference_stack" }, qdrant_point_id: randomUUID(), memory_type: "preference", category: "stack", is_pinned: true, reference_count: 7, last_referenced_at: daysAgo(1), superseded_by: null, created_at: daysAgo(8), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("My timezone is Asia/Colombo."), content_hash: createHash("sha256").update("pref:timezone:asia-colombo").digest("hex"), platform: "claude", summary_json: { title: "Timezone", preference_key: "identity_timezone" }, qdrant_point_id: randomUUID(), memory_type: "preference", category: "identity", is_pinned: true, reference_count: 6, last_referenced_at: daysAgo(4), superseded_by: null, created_at: daysAgo(15), deleted_at: null },

  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("We are building Tallei memory sync for Claude and ChatGPT."), content_hash: createHash("sha256").update("fact:building:tallei-sync-a").digest("hex"), platform: "claude", summary_json: { title: "Project goal" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "project", is_pinned: false, reference_count: 4, last_referenced_at: daysAgo(5), superseded_by: null, created_at: daysAgo(18), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("We're building Tallei memory sync for Claude and ChatGPT."), content_hash: createHash("sha256").update("fact:building:tallei-sync-b").digest("hex"), platform: "claude", summary_json: { title: "Project goal duplicate" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "project", is_pinned: false, reference_count: 3, last_referenced_at: daysAgo(6), superseded_by: null, created_at: daysAgo(18), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Primary objective is low-latency recall under heavy load."), content_hash: createHash("sha256").update("fact:objective:latency").digest("hex"), platform: "claude", summary_json: { title: "Objective" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "project", is_pinned: false, reference_count: 4, last_referenced_at: daysAgo(7), superseded_by: null, created_at: daysAgo(16), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("We use graph extraction to connect entities across memories."), content_hash: createHash("sha256").update("fact:graph:extraction").digest("hex"), platform: "claude", summary_json: { title: "Graph extraction" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "architecture", is_pinned: false, reference_count: 2, last_referenced_at: daysAgo(8), superseded_by: null, created_at: daysAgo(14), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Redis warm cache and precomputed snapshots are enabled."), content_hash: createHash("sha256").update("fact:cache:warm-snapshots").digest("hex"), platform: "claude", summary_json: { title: "Caching" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "architecture", is_pinned: false, reference_count: 2, last_referenced_at: daysAgo(9), superseded_by: null, created_at: daysAgo(14), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Dashboard exposes connectors setup and memory graph view."), content_hash: createHash("sha256").update("fact:dashboard:views").digest("hex"), platform: "chatgpt", summary_json: { title: "Dashboard" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "product", is_pinned: false, reference_count: 2, last_referenced_at: daysAgo(4), superseded_by: null, created_at: daysAgo(11), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("MCP tools include recall_memories, save_memory, and save_preference."), content_hash: createHash("sha256").update("fact:mcp:tools").digest("hex"), platform: "claude", summary_json: { title: "MCP tools" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "product", is_pinned: false, reference_count: 3, last_referenced_at: daysAgo(3), superseded_by: null, created_at: daysAgo(10), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("OpenAPI importer should only include recall and save actions."), content_hash: createHash("sha256").update("fact:openapi:actions").digest("hex"), platform: "chatgpt", summary_json: { title: "OpenAPI action scope" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "setup", is_pinned: false, reference_count: 3, last_referenced_at: daysAgo(2), superseded_by: null, created_at: daysAgo(9), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("The service supports contradiction-safe preference superseding."), content_hash: createHash("sha256").update("fact:preferences:supersede").digest("hex"), platform: "claude", summary_json: { title: "Preference supersede" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "architecture", is_pinned: false, reference_count: 2, last_referenced_at: daysAgo(5), superseded_by: null, created_at: daysAgo(13), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Integration harness checks recall noise and duplicate suppression."), content_hash: createHash("sha256").update("fact:test:harness").digest("hex"), platform: "claude", summary_json: { title: "Testing harness" }, qdrant_point_id: randomUUID(), memory_type: "fact", category: "testing", is_pinned: false, reference_count: 1, last_referenced_at: daysAgo(5), superseded_by: null, created_at: daysAgo(6), deleted_at: null },

  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Yesterday we triaged onboarding bugs in chatgpt setup."), content_hash: createHash("sha256").update("event:yesterday:triage").digest("hex"), platform: "chatgpt", summary_json: { title: "Recent triage" }, qdrant_point_id: randomUUID(), memory_type: "event", category: "ops", is_pinned: false, reference_count: 2, last_referenced_at: daysAgo(1), superseded_by: null, created_at: daysAgo(1), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Last month we attended a conference about knowledge graphs."), content_hash: createHash("sha256").update("event:conference:last-month").digest("hex"), platform: "claude", summary_json: { title: "Old conference" }, qdrant_point_id: randomUUID(), memory_type: "event", category: "ops", is_pinned: false, reference_count: 1, last_referenced_at: daysAgo(40), superseded_by: null, created_at: daysAgo(40), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Two months ago we migrated from legacy instructions."), content_hash: createHash("sha256").update("event:migration:two-months").digest("hex"), platform: "claude", summary_json: { title: "Old migration event" }, qdrant_point_id: randomUUID(), memory_type: "event", category: "ops", is_pinned: false, reference_count: 1, last_referenced_at: daysAgo(62), superseded_by: null, created_at: daysAgo(62), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Last quarter we experimented with weekly memory digest emails."), content_hash: createHash("sha256").update("event:digest:last-quarter").digest("hex"), platform: "claude", summary_json: { title: "Old digest experiment" }, qdrant_point_id: randomUUID(), memory_type: "event", category: "ops", is_pinned: false, reference_count: 1, last_referenced_at: daysAgo(92), superseded_by: null, created_at: daysAgo(92), deleted_at: null },
  { id: randomUUID(), tenant_id: auth.tenantId, user_id: auth.userId, content_ciphertext: encryptMemoryContent("Last year we tested a prototype with local-only memory visibility."), content_hash: createHash("sha256").update("event:prototype:last-year").digest("hex"), platform: "claude", summary_json: { title: "Very old prototype" }, qdrant_point_id: randomUUID(), memory_type: "event", category: "ops", is_pinned: false, reference_count: 1, last_referenced_at: daysAgo(370), superseded_by: null, created_at: daysAgo(370), deleted_at: null },
];

let activeQuery = "";

MemoryRepository.prototype.listAll = async function listAll(_auth, options) {
  const includeTypes = Array.isArray(options?.types) && options.types.length > 0
    ? new Set(options.types)
    : null;
  return fixtures.filter((row) => {
    if (row.deleted_at !== null || row.superseded_by !== null) return false;
    if (includeTypes && !includeTypes.has(row.memory_type)) return false;
    return true;
  });
};

MemoryRepository.prototype.listPinnedPreferences = async function listPinnedPreferences() {
  return fixtures.filter((row) => row.memory_type === "preference" && row.is_pinned && row.superseded_by === null);
};

MemoryRepository.prototype.touchReferencedScoped = async function touchReferencedScoped(_auth, memoryIds) {
  const touchedAt = new Date().toISOString();
  for (const row of fixtures) {
    if (memoryIds.includes(row.id)) row.last_referenced_at = touchedAt;
  }
};

VectorRepository.prototype.searchVectors = async function searchVectors(_auth, _queryVector, limit) {
  const queryTokens = new Set(tokenize(activeQuery));
  const scored = fixtures.map((row) => {
    const plain = decryptMemoryContent(row.content_ciphertext);
    const rowTokens = new Set(tokenize(plain));
    let overlap = 0;
    for (const token of queryTokens) {
      if (rowTokens.has(token)) overlap += 1;
    }
    const score = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;
    return {
      memoryId: row.id,
      pointId: row.qdrant_point_id,
      score: Number(score.toFixed(4)),
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
};

const queries = [
  { q: "what is my favorite color", preferenceLike: true },
  { q: "what are we building", preferenceLike: false },
  { q: "what UI style do I prefer", preferenceLike: true },
  { q: "what is my name", preferenceLike: true },
  { q: "what stack should we use", preferenceLike: true },
  { q: "what happened yesterday", preferenceLike: false },
  { q: "summarize project architecture", preferenceLike: false },
  { q: "what is my timezone", preferenceLike: true },
  { q: "how does setup work", preferenceLike: false },
  { q: "what did we do last month", preferenceLike: false },
];

test("preference-first recall suppresses noise and duplicates", async () => {
  for (const entry of queries) {
    activeQuery = entry.q;
    const result = await hybridRecall(entry.q, auth, 6);

    if (entry.preferenceLike) {
      const topThree = result.memories.slice(0, 3);
      const hasPreference = topThree.some((memory) => memory.metadata.memory_type === "preference");
      assert.equal(
        hasPreference,
        true,
        `Expected a preference in top-3 for query: ${entry.q}`
      );
    }

    const nonEventQuery = !/\bevent|yesterday|last month|happened\b/i.test(entry.q);
    if (nonEventQuery) {
      const oldEventPresent = result.memories.some((memory) => {
        if (memory.metadata.memory_type !== "event") return false;
        const createdAt = typeof memory.metadata.createdAt === "string" ? memory.metadata.createdAt : "";
        const ageDays = (Date.now() - Date.parse(createdAt)) / 86_400_000;
        return Number.isFinite(ageDays) && ageDays > 30;
      });
      assert.equal(oldEventPresent, false, `Old events leaked into non-event query: ${entry.q}`);
    }

    for (let i = 0; i < result.memories.length; i += 1) {
      for (let j = i + 1; j < result.memories.length; j += 1) {
        const sim = jaccardSimilarity(result.memories[i].text, result.memories[j].text);
        assert.ok(sim <= 0.9, `Duplicate-like memories leaked for query "${entry.q}" (similarity=${sim.toFixed(3)})`);
      }
    }
  }
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
