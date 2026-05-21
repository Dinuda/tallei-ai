import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "crypto";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { EMBEDDING_DIMS } from "../cache/embedding-cache.js";

interface LoopEpisodeVectorResult {
  episodeId: string;
  score: number;
}

let _client: QdrantClient | null = null;
let _initialized = false;
let _ensureInFlight: Promise<void> | null = null;

function deterministicPointUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function getClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey || undefined,
      timeout: config.qdrantTimeoutMs,
    });
  }
  return _client;
}

async function ensureCollection(): Promise<void> {
  if (_initialized) return;
  if (_ensureInFlight) return _ensureInFlight;
  _ensureInFlight = (async () => {
    const client = getClient();
    const collectionName = config.loopQdrantCollectionName;
    const collections = await client.getCollections();
    const exists = collections.collections.some((collection) => collection.name === collectionName);
    if (!exists) {
      await client.createCollection(collectionName, {
        vectors: { size: EMBEDDING_DIMS, distance: "Cosine" },
        on_disk_payload: true,
      });
    }
    for (const index of [
      { field_name: "tenant_id", field_schema: "keyword" as const },
      { field_name: "user_id", field_schema: "keyword" as const },
      { field_name: "episode_id", field_schema: "keyword" as const },
      { field_name: "output_type", field_schema: "keyword" as const },
      { field_name: "sealed_at", field_schema: "datetime" as const },
    ]) {
      try {
        await client.createPayloadIndex(collectionName, { ...index, wait: true });
      } catch {
        // Index may already exist.
      }
    }
    _initialized = true;
  })().finally(() => {
    _ensureInFlight = null;
  });
  return _ensureInFlight;
}

export class LoopEpisodeVectorRepository {
  async ensureReady(): Promise<void> {
    await ensureCollection();
  }

  async upsertEpisodeVector(input: {
    auth: AuthContext;
    episodeId: string;
    outputType: string;
    sealedAt: string;
    sources: string[];
    tools: string[];
    sourceFingerprint?: string;
    extractionVersion?: string;
    vector: number[];
  }): Promise<void> {
    await ensureCollection();
    const client = getClient();
    const pointId = deterministicPointUuid(`loop-episode:${input.auth.tenantId}:${input.auth.userId}:${input.episodeId}`);
    await client.upsert(config.loopQdrantCollectionName, {
      wait: false,
      points: [{
        id: pointId,
        vector: input.vector,
        payload: {
          tenant_id: input.auth.tenantId,
          user_id: input.auth.userId,
          episode_id: input.episodeId,
          output_type: input.outputType,
          sealed_at: input.sealedAt,
          sources: input.sources,
          tools: input.tools,
          source_fingerprint: input.sourceFingerprint ?? null,
          extraction_version: input.extractionVersion ?? null,
        },
      }],
    });
  }

  async searchSimilarEpisodes(input: {
    auth: AuthContext;
    vector: number[];
    limit: number;
    outputType?: string;
    excludeEpisodeId?: string;
  }): Promise<LoopEpisodeVectorResult[]> {
    await ensureCollection();
    const client = getClient();
    const must: Array<Record<string, unknown>> = [
      { key: "tenant_id", match: { value: input.auth.tenantId } },
      { key: "user_id", match: { value: input.auth.userId } },
    ];
    if (input.outputType) {
      must.push({ key: "output_type", match: { value: input.outputType } });
    }
    const mustNot: Array<Record<string, unknown>> = [];
    if (input.excludeEpisodeId) {
      mustNot.push({ key: "episode_id", match: { value: input.excludeEpisodeId } });
    }
    const points = await client.search(config.loopQdrantCollectionName, {
      vector: input.vector,
      limit: Math.max(1, input.limit),
      filter: {
        must,
        must_not: mustNot.length > 0 ? mustNot : undefined,
      },
      with_payload: ["episode_id"],
      with_vector: false,
    });
    return points
      .map((point) => {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        return {
          episodeId: typeof payload.episode_id === "string" ? payload.episode_id : "",
          score: typeof point.score === "number" ? point.score : 0,
        };
      })
      .filter((row) => row.episodeId.length > 0);
  }
}
