import { config } from "../../config/index.js";
import { embedText } from "../../infrastructure/cache/embedding-cache.js";
import { LoopEpisodeVectorRepository } from "../../infrastructure/repositories/loop-episode-vector.repository.js";
import { aiProviderRegistry, isRetriableProviderError } from "../../providers/ai/index.js";
import { CircuitOpenError } from "../../shared/errors/provider-errors.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type {
  EpisodeRecord,
  LoopMinerEpisodeEmbeddingMapView,
  LoopMinerEpisodeEmbeddingPoint,
  LoopMinerRepository,
} from "./core/loop-miner.types.js";
import {
  deriveCanonicalLoopFacet,
  deriveWorkspaceTracePayload,
  episodeEmbeddingText,
  episodeEmbeddingTextHash,
} from "./core/loop-miner-helpers.js";

const loopEpisodeVectorRepository = new LoopEpisodeVectorRepository();
const LOOP_EPISODE_EMBED_MAX_ATTEMPTS = 4;
const LOOP_EPISODE_EMBED_BASE_DELAY_MS = 1_000;
const LOOP_EPISODE_EMBED_CIRCUIT_COOLDOWN_MS = 22_000;
const LOOP_EPISODE_EMBED_MAX_DELAY_MS = 16_000;
const LOOP_EPISODE_EMBED_CHUNK_SIZE = 10;
const LOOP_EPISODE_EMBED_CHUNK_GAP_MS = 250;
const MAX_EPISODES_FOR_MAP = 120;
const QDRANT_MAP_TIMEOUT_MS = 4_000;
const EMBED_PHASE_TIMEOUT_MS = 25_000;
const MAP_BUILD_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function hashToUnit(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 1_677_761_9);
  }
  return (hash >>> 0) / 4_294_967_295;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function vectorNormSquared(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return sum;
}

function isRetriableEmbeddingError(error: unknown): boolean {
  if (isRetriableProviderError(error)) return true;
  const message = errorMessage(error).toLowerCase();
  return /connection error|fetch failed|network|socket|econn|enotfound|eai_again|timeout|temporar/i.test(message);
}

function embedRetryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof CircuitOpenError) {
    return LOOP_EPISODE_EMBED_CIRCUIT_COOLDOWN_MS;
  }
  return Math.min(
    LOOP_EPISODE_EMBED_MAX_DELAY_MS,
    LOOP_EPISODE_EMBED_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  );
}

async function batchEmbedTextsWithRetry(texts: string[]): Promise<(readonly number[])[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOP_EPISODE_EMBED_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await aiProviderRegistry.embed({
        model: config.embeddingModel,
        input: texts,
        dimensions: config.embeddingDims,
      });
      if (response.vectors.length !== texts.length) {
        throw new Error(`Embedding provider returned ${response.vectors.length} vectors for ${texts.length} inputs`);
      }
      return [...response.vectors];
    } catch (error) {
      lastError = error;
      if (attempt >= LOOP_EPISODE_EMBED_MAX_ATTEMPTS || !isRetriableEmbeddingError(error)) {
        throw error;
      }
      await sleep(embedRetryDelayMs(error, attempt));
    }
  }
  throw lastError;
}

async function embedSingleTextWithRetry(text: string): Promise<number[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOP_EPISODE_EMBED_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await embedText(text);
    } catch (error) {
      lastError = error;
      if (attempt >= LOOP_EPISODE_EMBED_MAX_ATTEMPTS || !isRetriableEmbeddingError(error)) {
        throw error;
      }
      await sleep(embedRetryDelayMs(error, attempt));
    }
  }
  throw lastError;
}

async function embedEpisodeTextsResilient(texts: string[]): Promise<Array<number[] | null>> {
  const vectors: Array<number[] | null> = new Array(texts.length).fill(null);
  for (let offset = 0; offset < texts.length; offset += LOOP_EPISODE_EMBED_CHUNK_SIZE) {
    const chunk = texts.slice(offset, offset + LOOP_EPISODE_EMBED_CHUNK_SIZE);
    const chunkStart = offset;
    try {
      const chunkVectors = await batchEmbedTextsWithRetry(chunk);
      for (let index = 0; index < chunkVectors.length; index += 1) {
        vectors[chunkStart + index] = [...chunkVectors[index]];
      }
    } catch {
      for (let index = 0; index < chunk.length; index += 1) {
        try {
          vectors[chunkStart + index] = await embedSingleTextWithRetry(chunk[index]);
        } catch {
          vectors[chunkStart + index] = null;
        }
      }
    }
    if (offset + LOOP_EPISODE_EMBED_CHUNK_SIZE < texts.length) {
      await sleep(LOOP_EPISODE_EMBED_CHUNK_GAP_MS);
    }
  }
  return vectors;
}

export function projectEpisodesTo2d(
  episodes: Array<{ episode: EpisodeRecord; vector: number[] }>
): LoopMinerEpisodeEmbeddingPoint[] {
  if (episodes.length === 0) return [];
  if (episodes.length === 1) {
    const only = episodes[0];
    return [{
      episodeId: only.episode.id,
      intent: only.episode.intent,
      outputType: only.episode.outputType,
      sealedAt: only.episode.sealedAt,
      turnCount: only.episode.turnCount,
      sources: only.episode.sources,
      embeddingStatus: only.episode.embeddingStatus,
      x: 0,
      y: 0,
    }];
  }

  const sampleCount = episodes.length;
  const dims = Math.max(...episodes.map(({ vector }) => vector.length));
  if (dims <= 0) return [];

  const matrix = episodes.map(({ vector }) => {
    const row = new Array<number>(dims).fill(0);
    for (let index = 0; index < vector.length; index += 1) row[index] = vector[index] ?? 0;
    return row;
  });

  const means = new Array<number>(dims).fill(0);
  for (const row of matrix) {
    for (let dim = 0; dim < dims; dim += 1) means[dim] += row[dim];
  }
  for (let dim = 0; dim < dims; dim += 1) means[dim] /= sampleCount;
  for (const row of matrix) {
    for (let dim = 0; dim < dims; dim += 1) row[dim] -= means[dim];
  }

  const multiplyCovariance = (vector: number[]): number[] => {
    const result = new Array<number>(dims).fill(0);
    const scale = sampleCount > 1 ? 1 / (sampleCount - 1) : 1;
    for (const row of matrix) {
      let dot = 0;
      for (let dim = 0; dim < dims; dim += 1) dot += row[dim] * vector[dim];
      if (Math.abs(dot) <= 1e-12) continue;
      for (let dim = 0; dim < dims; dim += 1) result[dim] += row[dim] * dot;
    }
    for (let dim = 0; dim < dims; dim += 1) result[dim] *= scale;
    return result;
  };

  const normalizeVector = (vector: number[]): number[] => {
    let normSquared = 0;
    for (const value of vector) normSquared += value * value;
    const norm = Math.sqrt(normSquared);
    if (!Number.isFinite(norm) || norm <= 1e-12) return vector.map(() => 0);
    return vector.map((value) => value / norm);
  };

  const powerIteration = (orthogonalTo?: number[]): number[] => {
    let candidate = normalizeVector(new Array<number>(dims).fill(1 / Math.sqrt(Math.max(1, dims))));
    for (let iteration = 0; iteration < 40; iteration += 1) {
      let next = multiplyCovariance(candidate);
      if (orthogonalTo) {
        let projection = 0;
        for (let dim = 0; dim < dims; dim += 1) projection += next[dim] * orthogonalTo[dim];
        for (let dim = 0; dim < dims; dim += 1) next[dim] -= projection * orthogonalTo[dim];
      }
      candidate = normalizeVector(next);
    }
    return candidate;
  };

  const componentX = powerIteration();
  const componentY = powerIteration(componentX);
  const xValues = matrix.map((row) => row.reduce((sum, value, dim) => sum + (value * componentX[dim]), 0));
  const yValues = matrix.map((row) => row.reduce((sum, value, dim) => sum + (value * componentY[dim]), 0));
  const maxAbsX = Math.max(...xValues.map((value) => Math.abs(value)), 1e-9);
  const maxAbsY = Math.max(...yValues.map((value) => Math.abs(value)), 1e-9);

  return episodes.map(({ episode }, index) => ({
    episodeId: episode.id,
    intent: episode.intent,
    outputType: episode.outputType,
    sealedAt: episode.sealedAt,
    turnCount: episode.turnCount,
    sources: episode.sources,
    embeddingStatus: episode.embeddingStatus,
    x: xValues[index] / maxAbsX,
    y: yValues[index] / maxAbsY,
  }));
}

export function projectEpisodesLexically(episodes: EpisodeRecord[]): LoopMinerEpisodeEmbeddingPoint[] {
  if (episodes.length === 0) return [];
  if (episodes.length === 1) {
    const only = episodes[0];
    return [{
      episodeId: only.id,
      intent: only.intent,
      outputType: only.outputType,
      sealedAt: only.sealedAt,
      turnCount: only.turnCount,
      sources: only.sources,
      embeddingStatus: only.embeddingStatus,
      x: 0,
      y: 0,
    }];
  }

  const byType = new Map<string, EpisodeRecord[]>();
  for (const episode of episodes) {
    const key = episode.outputType || "unknown";
    const group = byType.get(key) ?? [];
    group.push(episode);
    byType.set(key, group);
  }
  const typeKeys = [...byType.keys()].sort();
  const typeCount = typeKeys.length;

  return episodes.map((episode) => {
    const outputType = episode.outputType || "unknown";
    const typeIndex = Math.max(0, typeKeys.indexOf(outputType));
    const group = [...(byType.get(outputType) ?? [episode])].sort((left, right) => left.sealedAt.localeCompare(right.sealedAt));
    const indexInGroup = Math.max(0, group.findIndex((candidate) => candidate.id === episode.id));
    const groupSize = group.length;
    const xBase = typeCount <= 1 ? 0 : (typeIndex / (typeCount - 1)) * 2 - 1;
    const yBase = groupSize <= 1 ? 0 : (indexInGroup / (groupSize - 1)) * 2 - 1;
    const jitterX = (hashToUnit(`${episode.id}:${episode.intent}`) - 0.5) * 0.18;
    const jitterY = (hashToUnit(`${episode.intent}:${episode.sealedAt}`) - 0.5) * 0.18;
    return {
      episodeId: episode.id,
      intent: episode.intent,
      outputType: episode.outputType,
      sealedAt: episode.sealedAt,
      turnCount: episode.turnCount,
      sources: episode.sources,
      embeddingStatus: episode.embeddingStatus,
      x: Math.max(-1, Math.min(1, xBase + jitterX)),
      y: Math.max(-1, Math.min(1, yBase + jitterY)),
    };
  });
}

function isValidVector(vector: number[]): boolean {
  if (vector.length !== config.embeddingDims) return false;
  if (vector.some((value) => !Number.isFinite(value))) return false;
  return vectorNormSquared(vector) > 1e-12;
}

function scheduleEpisodeVectorPersistence(input: {
  auth: AuthContext;
  episode: EpisodeRecord;
  vector: number[];
  embeddingTextHash: string;
  repository?: Pick<LoopMinerRepository, "updateEpisodeEmbeddingMetadata">;
}): void {
  void (async () => {
    const canonicalFacet = deriveCanonicalLoopFacet(input.episode);
    const workspacePayload = deriveWorkspaceTracePayload(input.episode, input.vector);
    await loopEpisodeVectorRepository.upsertEpisodeVector({
      auth: input.auth,
      episodeId: input.episode.id,
      outputType: input.episode.outputType,
      canonicalDomain: canonicalFacet.operationalDomain,
      mechanismSignature: canonicalFacet.mechanismSignature,
      abstractedJtbd: canonicalFacet.abstractedJtbd,
      subjectAnchor: workspacePayload.metadata.subject_anchor,
      operationalDomain: workspacePayload.metadata.operational_domain,
      inputArtifactClasses: workspacePayload.metadata.input_artifact_classes,
      outputArtifactClasses: workspacePayload.metadata.output_artifact_classes,
      category: workspacePayload.metadata.category,
      platform: workspacePayload.provenance.platform,
      writtenAt: workspacePayload.provenance.written_at,
      sealedAt: input.episode.sealedAt,
      sources: input.episode.sources,
      tools: input.episode.toolNames,
      sourceFingerprint: input.episode.sourceFingerprint,
      extractionVersion: input.episode.extractionVersion,
      vector: input.vector,
    });
    await input.repository?.updateEpisodeEmbeddingMetadata?.({
      auth: input.auth,
      episodeId: input.episode.id,
      embeddingTextHash: input.embeddingTextHash,
      status: "ready",
      embeddedAt: new Date().toISOString(),
    });
  })().catch(() => {});
}

async function loadStoredEpisodeVectors(input: {
  auth: AuthContext;
  episodes: EpisodeRecord[];
}): Promise<{ vectorsByEpisodeId: Map<string, number[]>; storeError?: string }> {
  const vectorsByEpisodeId = new Map<string, number[]>();
  const missingEpisodeIds: string[] = [];
  try {
    await withTimeout(loopEpisodeVectorRepository.ensureReady(), QDRANT_MAP_TIMEOUT_MS, "Qdrant ensureReady");
    const stored = await withTimeout(
      loopEpisodeVectorRepository.getEpisodeVectors({
        auth: input.auth,
        episodeIds: input.episodes.map((episode) => episode.id),
      }),
      QDRANT_MAP_TIMEOUT_MS,
      "Qdrant getEpisodeVectors"
    );
    for (const episode of input.episodes) {
      const vector = stored.get(episode.id);
      if (vector && isValidVector(vector)) {
        vectorsByEpisodeId.set(episode.id, vector);
      } else {
        missingEpisodeIds.push(episode.id);
      }
    }
  } catch (error) {
    return {
      vectorsByEpisodeId,
      storeError: errorMessage(error),
    };
  }
  return { vectorsByEpisodeId };
}

function finalizeEmbeddingMapView(input: {
  runId: string;
  episodes: EpisodeRecord[];
  vectorsByEpisodeId: Map<string, number[]>;
  vectorStoreEnabled: boolean;
  reasonPrefix?: string;
}): LoopMinerEpisodeEmbeddingMapView {
  const episodeIds = input.episodes.map((episode) => episode.id);
  const projected = projectEpisodesTo2d(
    input.episodes
      .map((episode) => {
        const vector = input.vectorsByEpisodeId.get(episode.id);
        if (!vector) return null;
        return { episode, vector };
      })
      .filter((value): value is { episode: EpisodeRecord; vector: number[] } => value !== null)
  );
  if (projected.length > 0) {
    const mappedIds = new Set(projected.map((point) => point.episodeId));
    return {
      runId: input.runId,
      points: projected,
      meta: {
        totalEpisodes: input.episodes.length,
        mappedEpisodes: projected.length,
        missingEpisodeIds: episodeIds.filter((id) => !mappedIds.has(id)),
        vectorStoreEnabled: input.vectorStoreEnabled,
        reason: input.reasonPrefix,
      },
    };
  }

  const lexicalPoints = projectEpisodesLexically(input.episodes);
  return {
    runId: input.runId,
    points: lexicalPoints,
    meta: {
      totalEpisodes: input.episodes.length,
      mappedEpisodes: lexicalPoints.length,
      missingEpisodeIds: [],
      vectorStoreEnabled: input.vectorStoreEnabled,
      reason: input.reasonPrefix
        ? `${input.reasonPrefix}; showing lexical layout fallback.`
        : lexicalPoints.length > 0
          ? "Showing lexical layout fallback (embeddings unavailable)."
          : "Episode embeddings could not be generated for this run.",
    },
  };
}

async function buildLoopMinerEpisodeEmbeddingMapInner(input: {
  auth: AuthContext;
  runId: string;
  episodes: EpisodeRecord[];
  repository?: Pick<LoopMinerRepository, "updateEpisodeEmbeddingMetadata">;
}): Promise<LoopMinerEpisodeEmbeddingMapView> {
  const episodes = input.episodes.slice(0, MAX_EPISODES_FOR_MAP);
  const vectorStoreEnabled = Boolean(config.qdrantUrl);

  if (episodes.length === 0) {
    return {
      runId: input.runId,
      points: [],
      meta: {
        totalEpisodes: 0,
        mappedEpisodes: 0,
        missingEpisodeIds: [],
        vectorStoreEnabled,
        reason: "No episodes available for this run.",
      },
    };
  }

  const vectorsByEpisodeId = new Map<string, number[]>();
  let storeError: string | undefined;

  if (vectorStoreEnabled) {
    const stored = await loadStoredEpisodeVectors({ auth: input.auth, episodes });
    storeError = stored.storeError;
    for (const [episodeId, vector] of stored.vectorsByEpisodeId.entries()) {
      vectorsByEpisodeId.set(episodeId, vector);
    }
  }

  const missingEpisodeIds = episodes
    .map((episode) => episode.id)
    .filter((episodeId) => !vectorsByEpisodeId.has(episodeId));

  if (missingEpisodeIds.length > 0 && storeError) {
    return finalizeEmbeddingMapView({
      runId: input.runId,
      episodes,
      vectorsByEpisodeId,
      vectorStoreEnabled,
      reasonPrefix: `Vector store unavailable (${storeError})`,
    });
  }

  if (missingEpisodeIds.length > 0) {
    const missingSet = new Set(missingEpisodeIds);
    const toEmbed = episodes.filter((episode) => missingSet.has(episode.id));
    const texts = toEmbed.map((episode) => episodeEmbeddingText(episode));
    let embedded: Array<number[] | null>;
    try {
      embedded = await withTimeout(embedEpisodeTextsResilient(texts), EMBED_PHASE_TIMEOUT_MS, "Episode embedding");
    } catch (error) {
      return finalizeEmbeddingMapView({
        runId: input.runId,
        episodes,
        vectorsByEpisodeId,
        vectorStoreEnabled,
        reasonPrefix: storeError
          ? `Vector store unavailable (${storeError}) and ${errorMessage(error)}`
          : errorMessage(error),
      });
    }
    for (const [index, episode] of toEmbed.entries()) {
      const vector = embedded[index];
      if (!vector || !isValidVector(vector)) continue;
      vectorsByEpisodeId.set(episode.id, vector);
      const hash = episodeEmbeddingTextHash(texts[index] ?? episodeEmbeddingText(episode));
      if (vectorStoreEnabled) {
        scheduleEpisodeVectorPersistence({
          auth: input.auth,
          episode,
          vector,
          embeddingTextHash: hash,
          repository: input.repository,
        });
      }
    }
  }

  return finalizeEmbeddingMapView({
    runId: input.runId,
    episodes,
    vectorsByEpisodeId,
    vectorStoreEnabled,
    reasonPrefix: storeError ? `Vector store unavailable (${storeError})` : undefined,
  });
}

export async function buildLoopMinerEpisodeEmbeddingMap(input: {
  auth: AuthContext;
  runId: string;
  episodes: EpisodeRecord[];
  repository?: Pick<LoopMinerRepository, "updateEpisodeEmbeddingMetadata">;
}): Promise<LoopMinerEpisodeEmbeddingMapView> {
  try {
    return await withTimeout(
      buildLoopMinerEpisodeEmbeddingMapInner(input),
      MAP_BUILD_TIMEOUT_MS,
      "Loop miner embedding map"
    );
  } catch (error) {
    const episodes = input.episodes.slice(0, MAX_EPISODES_FOR_MAP);
    const lexicalPoints = projectEpisodesLexically(episodes);
    return {
      runId: input.runId,
      points: lexicalPoints,
      meta: {
        totalEpisodes: input.episodes.length,
        mappedEpisodes: lexicalPoints.length,
        missingEpisodeIds: [],
        vectorStoreEnabled: Boolean(config.qdrantUrl),
        reason: lexicalPoints.length > 0
          ? `${errorMessage(error)}; showing lexical layout fallback.`
          : errorMessage(error),
      },
    };
  }
}
