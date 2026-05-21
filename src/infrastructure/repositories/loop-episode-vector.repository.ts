import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "crypto";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { EMBEDDING_DIMS } from "../cache/embedding-cache.js";

interface LoopEpisodeVectorResult {
  episodeId: string;
  score: number;
}

export interface LoopEpisodeGroupedRun {
  pointId: string;
  episodeId: string;
  text: string;
  score: number;
  metadata: {
    subjectAnchor: string;
    operationalDomain: string;
    inputArtifactClasses: string[];
    outputArtifactClasses: string[];
    category: string | null;
  };
  provenance: {
    platform: string;
    writtenAt: string;
  };
}

export interface LoopEpisodeGroupedResult {
  subjectAnchor: string;
  runs: LoopEpisodeGroupedRun[];
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
    } else {
      const details = await client.getCollection(collectionName);
      const vectorsConfig = (details?.config?.params as { vectors?: unknown } | undefined)?.vectors;
      const size =
        typeof vectorsConfig === "object" &&
        vectorsConfig !== null &&
        "size" in vectorsConfig &&
        typeof (vectorsConfig as { size?: unknown }).size === "number"
          ? (vectorsConfig as { size: number }).size
          : null;
      if (typeof size === "number" && size !== EMBEDDING_DIMS) {
        throw new Error(
          `Loop Qdrant collection "${collectionName}" vector size is ${size}, but EMBEDDING_DIMS=${EMBEDDING_DIMS}.`
        );
      }
    }
    for (const index of [
      { field_name: "tenant_id", field_schema: "keyword" as const },
      { field_name: "user_id", field_schema: "keyword" as const },
      { field_name: "episode_id", field_schema: "keyword" as const },
      { field_name: "output_type", field_schema: "keyword" as const },
      { field_name: "canonical_domain", field_schema: "keyword" as const },
      { field_name: "mechanism_signature", field_schema: "keyword" as const },
      { field_name: "metadata.subject_anchor", field_schema: "keyword" as const },
      { field_name: "metadata.operational_domain", field_schema: "keyword" as const },
      { field_name: "provenance.written_at", field_schema: "datetime" as const },
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
    canonicalDomain: string;
    mechanismSignature: string;
    abstractedJtbd: string;
    subjectAnchor: string;
    operationalDomain: string;
    inputArtifactClasses: string[];
    outputArtifactClasses: string[];
    category: string | null;
    platform: string;
    writtenAt: string;
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
          canonical_domain: input.canonicalDomain,
          mechanism_signature: input.mechanismSignature,
          abstracted_jtbd: input.abstractedJtbd,
          text: input.abstractedJtbd,
          metadata: {
            subject_anchor: input.subjectAnchor,
            operational_domain: input.operationalDomain,
            input_artifact_classes: input.inputArtifactClasses,
            output_artifact_classes: input.outputArtifactClasses,
            category: input.category,
          },
          provenance: {
            platform: input.platform,
            written_at: input.writtenAt,
          },
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
    canonicalDomain?: string;
    mechanismSignature?: string;
    excludeEpisodeId?: string;
  }): Promise<LoopEpisodeVectorResult[]> {
    await ensureCollection();
    const client = getClient();
    const must: Array<Record<string, unknown>> = [
      { key: "tenant_id", match: { value: input.auth.tenantId } },
      { key: "user_id", match: { value: input.auth.userId } },
    ];
    const should: Array<Record<string, unknown>> = [];
    if (input.mechanismSignature) {
      should.push({ key: "mechanism_signature", match: { value: input.mechanismSignature } });
    }
    if (input.canonicalDomain) {
      should.push({ key: "canonical_domain", match: { value: input.canonicalDomain } });
    }
    if (input.outputType) {
      should.push({ key: "output_type", match: { value: input.outputType } });
    }
    const mustNot: Array<Record<string, unknown>> = [];
    if (input.excludeEpisodeId) {
      mustNot.push({ key: "episode_id", match: { value: input.excludeEpisodeId } });
    }
    const filter: Record<string, unknown> = {
      must,
      must_not: mustNot.length > 0 ? mustNot : undefined,
    };
    if (should.length > 0) {
      filter.min_should = {
        conditions: should,
        min_count: 1,
      };
    }
    const points = await client.search(config.loopQdrantCollectionName, {
      vector: input.vector,
      limit: Math.max(1, input.limit),
      filter,
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

  async searchGroupedEpisodesBySubjectAnchor(input: {
    auth: AuthContext;
    vector: number[];
    limit: number;
    scoreThreshold?: number;
    groupSize?: number;
    excludeEpisodeId?: string;
  }): Promise<LoopEpisodeGroupedResult[]> {
    await ensureCollection();
    const client = getClient();
    const must: Array<Record<string, unknown>> = [
      { key: "tenant_id", match: { value: input.auth.tenantId } },
      { key: "user_id", match: { value: input.auth.userId } },
    ];
    const mustNot: Array<Record<string, unknown>> = [];
    if (input.excludeEpisodeId) {
      mustNot.push({ key: "episode_id", match: { value: input.excludeEpisodeId } });
    }

    const grouped = await client.searchPointGroups(config.loopQdrantCollectionName, {
      vector: input.vector,
      filter: {
        must,
        must_not: mustNot.length > 0 ? mustNot : undefined,
      },
      with_payload: true,
      with_vector: false,
      score_threshold: input.scoreThreshold ?? 0.65,
      group_by: "metadata.subject_anchor",
      group_size: Math.max(1, input.groupSize ?? 20),
      limit: Math.max(1, input.limit),
    });
    const groups = Array.isArray(grouped?.groups) ? grouped.groups : [];
    return groups
      .map((group) => {
        const subjectAnchor = typeof group.id === "string" ? group.id : String(group.id ?? "");
        const hits = Array.isArray(group.hits) ? group.hits : [];
        const runs = hits
          .map((hit): LoopEpisodeGroupedRun | null => {
            const payload = (hit.payload ?? {}) as Record<string, unknown>;
            const metadata = payload.metadata && typeof payload.metadata === "object"
              ? payload.metadata as Record<string, unknown>
              : {};
            const provenance = payload.provenance && typeof payload.provenance === "object"
              ? payload.provenance as Record<string, unknown>
              : {};
            const episodeId = typeof payload.episode_id === "string" ? payload.episode_id : "";
            if (!episodeId) return null;
            return {
              pointId: String(hit.id ?? episodeId),
              episodeId,
              text: typeof payload.text === "string" ? payload.text : "",
              score: typeof hit.score === "number" ? hit.score : 0,
              metadata: {
                subjectAnchor: typeof metadata.subject_anchor === "string" ? metadata.subject_anchor : subjectAnchor,
                operationalDomain: typeof metadata.operational_domain === "string" ? metadata.operational_domain : "System_Design",
                inputArtifactClasses: Array.isArray(metadata.input_artifact_classes)
                  ? metadata.input_artifact_classes.filter((value): value is string => typeof value === "string")
                  : [],
                outputArtifactClasses: Array.isArray(metadata.output_artifact_classes)
                  ? metadata.output_artifact_classes.filter((value): value is string => typeof value === "string")
                  : [],
                category: typeof metadata.category === "string" ? metadata.category : null,
              },
              provenance: {
                platform: typeof provenance.platform === "string" ? provenance.platform : "unknown",
                writtenAt: typeof provenance.written_at === "string"
                  ? provenance.written_at
                  : typeof payload.sealed_at === "string"
                    ? payload.sealed_at
                    : new Date().toISOString(),
              },
            };
          })
          .filter((run): run is LoopEpisodeGroupedRun => Boolean(run));
        return {
          subjectAnchor: subjectAnchor || "Unlabeled Loop",
          runs,
        };
      })
      .filter((group) => group.runs.length > 0);
  }
}
