import assert from "node:assert/strict";
import test, { after } from "node:test";

import { QdrantClient } from "@qdrant/js-client-rest";

process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-internal-secret";
process.env.TALLEI_DB__URL ??= "postgresql://test:test@localhost:5432/test";
process.env.TALLEI_AUTH__JWT_SECRET ??= "test-jwt-secret";

const originalGetCollections = QdrantClient.prototype.getCollections;
const originalCreateCollection = QdrantClient.prototype.createCollection;
const originalCreatePayloadIndex = QdrantClient.prototype.createPayloadIndex;
const originalUpsert = QdrantClient.prototype.upsert;
const originalSearch = QdrantClient.prototype.search;
const originalSearchPointGroups = QdrantClient.prototype.searchPointGroups;

after(() => {
  QdrantClient.prototype.getCollections = originalGetCollections;
  QdrantClient.prototype.createCollection = originalCreateCollection;
  QdrantClient.prototype.createPayloadIndex = originalCreatePayloadIndex;
  QdrantClient.prototype.upsert = originalUpsert;
  QdrantClient.prototype.search = originalSearch;
  QdrantClient.prototype.searchPointGroups = originalSearchPointGroups;
});

test("loop episode vector repository writes canonical payload fields and indexes", async () => {
  const payloadIndexFields: string[] = [];
  let upsertPayload: Record<string, unknown> | null = null;

  QdrantClient.prototype.getCollections = (async () => ({ collections: [] })) as typeof QdrantClient.prototype.getCollections;
  QdrantClient.prototype.createCollection = (async () => ({ result: true } as unknown)) as typeof QdrantClient.prototype.createCollection;
  QdrantClient.prototype.createPayloadIndex = (async (_collection, input) => {
    payloadIndexFields.push(String((input as { field_name?: string }).field_name ?? ""));
    return { result: true } as unknown;
  }) as typeof QdrantClient.prototype.createPayloadIndex;
  QdrantClient.prototype.upsert = (async (_collection, body) => {
    upsertPayload = body as unknown as Record<string, unknown>;
    return { status: "ok" } as unknown;
  }) as typeof QdrantClient.prototype.upsert;
  QdrantClient.prototype.search = (async () => []) as typeof QdrantClient.prototype.search;

  const { LoopEpisodeVectorRepository } = await import(
    "../../../src/infrastructure/repositories/loop-episode-vector.repository.js"
  );
  const repo = new LoopEpisodeVectorRepository();
  await repo.upsertEpisodeVector({
    auth: {
      tenantId: "tenant-1",
      userId: "user-1",
      authMode: "internal",
      plan: "pro",
    },
    episodeId: "episode-1",
    outputType: "document",
    canonicalDomain: "operational_document_scoping",
    mechanismSignature: "input:vague_input|action:layout_expansion|artifact:document",
    abstractedJtbd: "convert rough notes into structured operating document",
    subjectAnchor: "AI Makers Curriculum",
    operationalDomain: "System_Design",
    inputArtifactClasses: ["docx", "blueprint_notes"],
    outputArtifactClasses: ["markdown"],
    category: "document",
    platform: "chatgpt",
    writtenAt: "2026-05-21T00:00:00.000Z",
    sealedAt: "2026-05-21T00:00:00.000Z",
    sources: ["chatgpt"],
    tools: ["chatgpt"],
    vector: [0.1, 0.2, 0.3],
  });

  assert.ok(payloadIndexFields.includes("canonical_domain"));
  assert.ok(payloadIndexFields.includes("mechanism_signature"));
  assert.ok(upsertPayload);
  const points = (upsertPayload?.points as Array<{ payload?: Record<string, unknown> }>) ?? [];
  assert.equal(points.length, 1);
  const payload = points[0]?.payload ?? {};
  assert.equal(payload["canonical_domain"], "operational_document_scoping");
  assert.equal(payload["mechanism_signature"], "input:vague_input|action:layout_expansion|artifact:document");
  assert.equal(payload["abstracted_jtbd"], "convert rough notes into structured operating document");
  const nestedMetadata = payload["metadata"] as Record<string, unknown>;
  assert.equal(nestedMetadata["subject_anchor"], "AI Makers Curriculum");
  const nestedProvenance = payload["provenance"] as Record<string, unknown>;
  assert.equal(nestedProvenance["platform"], "chatgpt");
});

test("loop episode vector repository searches with canonical filters and output-type fallback", async () => {
  let searchBody: Record<string, unknown> | null = null;

  QdrantClient.prototype.getCollections = (async () => ({
    collections: [{ name: process.env.TALLEI_QDRANT__LOOP_COLLECTION ?? "memories_v1_loop_episodes" }],
  })) as typeof QdrantClient.prototype.getCollections;
  QdrantClient.prototype.createCollection = (async () => ({ result: true } as unknown)) as typeof QdrantClient.prototype.createCollection;
  QdrantClient.prototype.createPayloadIndex = (async () => ({ result: true } as unknown)) as typeof QdrantClient.prototype.createPayloadIndex;
  QdrantClient.prototype.upsert = (async () => ({ status: "ok" } as unknown)) as typeof QdrantClient.prototype.upsert;
  QdrantClient.prototype.search = (async (_collection, body) => {
    searchBody = body as unknown as Record<string, unknown>;
    return [{
      score: 0.88,
      payload: { episode_id: "episode-2" },
    }] as unknown;
  }) as typeof QdrantClient.prototype.search;

  const { LoopEpisodeVectorRepository } = await import(
    "../../../src/infrastructure/repositories/loop-episode-vector.repository.js"
  );
  const repo = new LoopEpisodeVectorRepository();
  const hits = await repo.searchSimilarEpisodes({
    auth: {
      tenantId: "tenant-1",
      userId: "user-1",
      authMode: "internal",
      plan: "pro",
    },
    vector: [0.1, 0.2, 0.3],
    limit: 5,
    outputType: "document",
    canonicalDomain: "operational_document_scoping",
    mechanismSignature: "input:vague_input|action:layout_expansion|artifact:document",
    excludeEpisodeId: "episode-1",
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.episodeId, "episode-2");
  const filter = (searchBody?.filter ?? {}) as Record<string, unknown>;
  assert.equal(filter.should, undefined);
  const minShould = (filter.min_should ?? {}) as Record<string, unknown>;
  const conditions = (minShould.conditions ?? []) as Array<Record<string, unknown>>;
  assert.equal(minShould.min_count, 1);
  assert.equal(conditions.length, 3);
});

test("loop episode vector repository groups by subject anchor with relaxed threshold", async () => {
  let groupedBody: Record<string, unknown> | null = null;

  QdrantClient.prototype.getCollections = (async () => ({
    collections: [{ name: process.env.TALLEI_QDRANT__LOOP_COLLECTION ?? "memories_v1_loop_episodes" }],
  })) as typeof QdrantClient.prototype.getCollections;
  QdrantClient.prototype.createCollection = (async () => ({ result: true } as unknown)) as typeof QdrantClient.prototype.createCollection;
  QdrantClient.prototype.createPayloadIndex = (async () => ({ result: true } as unknown)) as typeof QdrantClient.prototype.createPayloadIndex;
  QdrantClient.prototype.upsert = (async () => ({ status: "ok" } as unknown)) as typeof QdrantClient.prototype.upsert;
  QdrantClient.prototype.search = (async () => []) as typeof QdrantClient.prototype.search;
  QdrantClient.prototype.searchPointGroups = (async (_collection, body) => {
    groupedBody = body as unknown as Record<string, unknown>;
    return {
      groups: [{
        id: "AI Makers Curriculum",
        hits: [{
          id: "point-1",
          score: 0.71,
          payload: {
            episode_id: "episode-2",
            text: "Week 6 curriculum optimization notes",
            metadata: {
              subject_anchor: "AI Makers Curriculum",
              operational_domain: "System_Design",
              input_artifact_classes: ["docx", "blueprint_notes"],
              output_artifact_classes: ["markdown"],
              category: "document",
            },
            provenance: {
              platform: "chatgpt",
              written_at: "2026-05-22T00:00:00.000Z",
            },
          },
        }],
      }],
    } as unknown;
  }) as typeof QdrantClient.prototype.searchPointGroups;

  const { LoopEpisodeVectorRepository } = await import(
    "../../../src/infrastructure/repositories/loop-episode-vector.repository.js"
  );
  const repo = new LoopEpisodeVectorRepository();
  const grouped = await repo.searchGroupedEpisodesBySubjectAnchor({
    auth: {
      tenantId: "tenant-1",
      userId: "user-1",
      authMode: "internal",
      plan: "pro",
    },
    vector: [0.1, 0.2, 0.3],
    limit: 20,
    groupSize: 20,
    scoreThreshold: 0.65,
    excludeEpisodeId: "episode-1",
  });

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.subjectAnchor, "AI Makers Curriculum");
  assert.equal(grouped[0]?.runs[0]?.episodeId, "episode-2");
  assert.equal(groupedBody?.group_by, "metadata.subject_anchor");
  assert.equal(groupedBody?.group_size, 20);
  assert.equal(groupedBody?.score_threshold, 0.65);
});
