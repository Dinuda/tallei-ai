import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "crypto";
import { config } from "../config.js";
import { EMBEDDING_DIMS } from "../services/embeddings.js";
import type { AuthContext } from "../types/auth.js";

export interface VectorSearchResult {
  pointId: string;
  memoryId: string;
  score: number;
}

let _qdrant: QdrantClient | null = null;
let _initialized = false;

function getQdrantClient(): QdrantClient {
  if (!_qdrant) {
    if (!config.qdrantUrl) {
      throw new Error("QDRANT_URL is required for the production memory backend");
    }

    _qdrant = new QdrantClient({
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey || undefined,
      timeout: 30,
    });
  }
  return _qdrant;
}

async function ensureCollection(): Promise<void> {
  if (_initialized) return;

  const client = getQdrantClient();
  const collectionName = config.qdrantCollectionName;

  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === collectionName);

  if (!exists) {
    await client.createCollection(collectionName, {
      vectors: {
        size: EMBEDDING_DIMS,
        distance: "Cosine",
      },
      on_disk_payload: true,
    });
  }

  const payloadIndexes: Array<{ field_name: string; field_schema: "keyword" | "datetime" }> = [
    { field_name: "tenant_id", field_schema: "keyword" },
    { field_name: "user_id", field_schema: "keyword" },
    { field_name: "memory_id", field_schema: "keyword" },
    { field_name: "platform", field_schema: "keyword" },
    { field_name: "created_at", field_schema: "datetime" },
  ];

  for (const index of payloadIndexes) {
    try {
      await client.createPayloadIndex(collectionName, {
        field_name: index.field_name,
        field_schema: index.field_schema,
        wait: true,
      });
    } catch {
      // Index may already exist.
    }
  }

  _initialized = true;
}

export class VectorRepository {
  async upsertMemoryVector(input: {
    auth: AuthContext;
    memoryId: string;
    pointId?: string;
    vector: number[];
    platform: string;
    createdAt: string;
  }): Promise<{ pointId: string }> {
    await ensureCollection();
    const client = getQdrantClient();

    const pointId = input.pointId ?? input.memoryId ?? randomUUID();

    await client.upsert(config.qdrantCollectionName, {
      wait: true,
      points: [
        {
          id: pointId,
          vector: input.vector,
          payload: {
            tenant_id: input.auth.tenantId,
            user_id: input.auth.userId,
            memory_id: input.memoryId,
            platform: input.platform,
            created_at: input.createdAt,
          },
        },
      ],
    });

    return { pointId };
  }

  async searchVectors(auth: AuthContext, queryVector: number[], limit: number): Promise<VectorSearchResult[]> {
    await ensureCollection();
    const client = getQdrantClient();

    const points = await client.search(config.qdrantCollectionName, {
      vector: queryVector,
      limit,
      filter: {
        must: [
          { key: "tenant_id", match: { value: auth.tenantId } },
          { key: "user_id", match: { value: auth.userId } },
        ],
      },
      with_payload: ["memory_id"],
      with_vector: false,
    });

    return points
      .map((point) => {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        const memoryId = typeof payload.memory_id === "string" ? payload.memory_id : "";
        const pointId = typeof point.id === "string" ? point.id : String(point.id);
        return {
          pointId,
          memoryId,
          score: typeof point.score === "number" ? point.score : 0,
        };
      })
      .filter((point) => point.memoryId.length > 0);
  }

  async deleteMemoryVector(auth: AuthContext, memoryId: string): Promise<void> {
    await ensureCollection();
    const client = getQdrantClient();

    await client.delete(config.qdrantCollectionName, {
      wait: true,
      filter: {
        must: [
          { key: "tenant_id", match: { value: auth.tenantId } },
          { key: "user_id", match: { value: auth.userId } },
          { key: "memory_id", match: { value: memoryId } },
        ],
      },
    });
  }
}
