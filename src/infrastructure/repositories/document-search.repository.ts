import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { createLogger } from "../../observability/index.js";
import { setRequestTimingFields } from "../../observability/request-timing.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export interface DocumentSearchHit {
  ref: string;
  title: string;
  score: number;
  preview: string;
}

export interface DocumentSearchIndexInput {
  auth: AuthContext;
  documentId: string;
  ref: string;
  title: string | null;
  content: string;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface DocumentSearchRepository {
  indexDocument(input: DocumentSearchIndexInput): Promise<void>;
  searchDocuments(query: string, auth: AuthContext, limit: number): Promise<DocumentSearchHit[]>;
}

const logger = createLogger({ baseFields: { component: "document_search_repository" } });
const DISCOVERY_ENGINE_BASE_URL = "https://discoveryengine.googleapis.com/v1";
const METADATA_TOKEN_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const CONTENT_MAX_BYTES = 950_000;
const CHUNK_TARGET_CHARS = 3_500;
const CHUNK_OVERLAP_CHARS = 350;
const CHUNK_MIN_ADVANCE_CHARS = 500;
const CHUNK_MAX_COUNT = 180;
const TOKEN_REFRESH_SKEW_MS = 30_000;
const DEFAULT_INDEX_TIMEOUT_MS = 8_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
const GCLOUD_TOKEN_TIMEOUT_MS = 4_000;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface VertexSearchResult {
  id?: string;
  document?: {
    id?: string;
    structData?: Record<string, unknown>;
    derivedStructData?: {
      snippets?: Array<{ snippet?: string }>;
    };
  };
  chunk?: {
    id?: string;
    documentMetadata?: {
      id?: string;
      structData?: Record<string, unknown>;
    };
    derivedStructData?: {
      snippets?: Array<{ snippet?: string }>;
    };
    content?: string;
  };
  modelScores?: Record<string, { values?: number[] }>;
}

interface VertexSearchResponse {
  results?: VertexSearchResult[];
}

interface VertexDocumentSearchRepositoryOptions {
  fetchImpl?: typeof fetch;
  accessTokenProvider?: () => Promise<string>;
  indexTimeoutMs?: number;
  searchTimeoutMs?: number;
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function toBase64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.max(64, Math.floor(value.length * 0.95));
  while (end > 64) {
    const candidate = value.slice(0, end);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    end = Math.floor(end * 0.8);
  }
  return value.slice(0, 64);
}

function normalizeDataStoreResource(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.startsWith("projects/")) return value.replace(/\/+$/, "");
  if (!config.googleProjectId) return null;
  return `projects/${config.googleProjectId}/locations/global/collections/default_collection/dataStores/${value}`;
}

function normalizeServingConfigResource(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.startsWith("projects/")) return value.replace(/\/+$/, "");
  return null;
}

function buildBranchResource(dataStoreResource: string): string {
  return `${dataStoreResource}/branches/default_branch`;
}

function resourceProject(resourceName: string): string | null {
  const match = resourceName.match(/^projects\/([^/]+)/);
  return match?.[1] ?? null;
}

function quoteFilterLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function summaryText(summary: Record<string, unknown>): string {
  const explicit = typeof summary["summary"] === "string" ? summary["summary"] : "";
  if (explicit.trim()) return explicit.trim();
  if (Array.isArray(summary["keyPoints"])) {
    const first = summary["keyPoints"].find((v) => typeof v === "string");
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  return "";
}

function chunkSummaryText(chunk: string, maxChars = 320): string {
  return chunk.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function modelScore(result: VertexSearchResult): number {
  if (!result.modelScores) return 0;
  for (const entry of Object.values(result.modelScores)) {
    const score = entry?.values?.find((value) => Number.isFinite(value));
    if (typeof score === "number") return score;
  }
  return 0;
}

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractErrorMessage(status: number, payloadText: string): string {
  const payload = parseJsonSafely(payloadText);
  if (payload && typeof payload === "object") {
    const message = (payload as { error?: { message?: string } }).error?.message;
    if (message) return `HTTP ${status}: ${message}`;
  }
  return `HTTP ${status}: ${payloadText.slice(0, 300) || "request failed"}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function chunkDocumentContent(rawContent: string): string[] {
  const content = rawContent.trim();
  if (!content) return [""];
  if (content.length <= CHUNK_TARGET_CHARS) return [content];

  const chunks: string[] = [];
  let start = 0;
  while (start < content.length && chunks.length < CHUNK_MAX_COUNT) {
    const hardEnd = Math.min(content.length, start + CHUNK_TARGET_CHARS);
    let end = hardEnd;

    if (hardEnd < content.length) {
      const scanStart = Math.max(start + CHUNK_MIN_ADVANCE_CHARS, hardEnd - 500);
      for (let i = hardEnd; i >= scanStart; i -= 1) {
        const char = content[i];
        if (char === "\n" || char === "." || char === " " || char === "\t") {
          end = i;
          break;
        }
      }
    }

    const chunk = content.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= content.length) break;

    const nextStart = Math.max(start + CHUNK_MIN_ADVANCE_CHARS, end - CHUNK_OVERLAP_CHARS);
    start = nextStart;
  }

  if (chunks.length === 0) return [content.slice(0, CHUNK_TARGET_CHARS)];
  return chunks;
}

export class VertexDocumentSearchRepository implements DocumentSearchRepository {
  private readonly fetchImpl: typeof fetch;
  private readonly accessTokenProvider: () => Promise<string>;
  private readonly indexTimeoutMs: number;
  private readonly searchTimeoutMs: number;

  private cachedAccessToken: string | null = null;
  private cachedAccessTokenExpiresAtMs = 0;
  private tokenInFlight: Promise<string> | null = null;

  constructor(options: VertexDocumentSearchRepositoryOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessTokenProvider = options.accessTokenProvider ?? (() => this.getAccessTokenFromMetadata());
    this.indexTimeoutMs = Math.max(1_000, options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS);
    this.searchTimeoutMs = Math.max(1_000, options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
  }

  async indexDocument(input: DocumentSearchIndexInput): Promise<void> {
    const startedAt = process.hrtime.bigint();
    if (!config.vertexDocumentSearchEnabled && !config.vertexDocumentSearchShadowEnabled) return;
    const dataStore = normalizeDataStoreResource(config.vertexSearchDataStore);
    if (!dataStore) {
      logger.warn("Vertex document search indexing skipped; data store is not configured", {
        event: "vertex_document_search_index_skipped",
        document_id: input.documentId,
        ref: input.ref,
      });
      setRequestTimingFields({
        vertex_document_index_ms: elapsedMs(startedAt),
        vertex_document_index_status: "skipped_no_datastore",
      });
      return;
    }

    const branch = buildBranchResource(dataStore);
    const summary = summaryText(input.summary);
    const searchBodyText = truncateUtf8(
      [input.title ?? "", input.ref, summary, input.content].filter(Boolean).join("\n\n"),
      CONTENT_MAX_BYTES
    );
    const chunks = chunkDocumentContent(searchBodyText);
    const totalChunks = chunks.length;

    const baseLogFields = {
      tenant_id: input.auth.tenantId,
      user_id: input.auth.userId,
      document_id: input.documentId,
      ref: input.ref,
      title: input.title ?? "",
      content_bytes: Buffer.byteLength(searchBodyText, "utf8"),
      chunk_count: totalChunks,
      data_store: dataStore,
      branch,
    };

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        const chunk = chunks[chunkIndex]!;
        const chunkId = `${input.documentId}--c-${String(chunkIndex + 1).padStart(4, "0")}`;
        const chunkDocumentId = encodeURIComponent(chunkId);
        const chunkDocumentName = `${branch}/documents/${chunkDocumentId}`;
        const chunkSummary = chunkSummaryText(chunk);
        const documentPayload = {
          id: chunkId,
          structData: {
            tenant_id: input.auth.tenantId,
            user_id: input.auth.userId,
            doc_id: input.documentId,
            chunk_index: chunkIndex + 1,
            chunk_total: totalChunks,
            ref: input.ref,
            title: input.title ?? "",
            summary: chunkSummary,
            doc_summary: summary,
            created_at: input.createdAt,
          },
          content: {
            mimeType: "text/plain",
            rawBytes: toBase64Utf8(chunk),
          },
        };

        try {
          await this.discoveryRequest({
            url: `${DISCOVERY_ENGINE_BASE_URL}/${branch}/documents?documentId=${chunkDocumentId}`,
            method: "POST",
            body: documentPayload,
            timeoutMs: this.indexTimeoutMs,
            billingProject: this.billingProject(dataStore),
          });
        } catch (error) {
          if (!this.isAlreadyExistsError(error)) throw error;
          await this.discoveryRequest({
            url: `${DISCOVERY_ENGINE_BASE_URL}/${chunkDocumentName}?updateMask=structData,content`,
            method: "PATCH",
            body: documentPayload,
            timeoutMs: this.indexTimeoutMs,
            billingProject: this.billingProject(dataStore),
          });
        }
      }

      setRequestTimingFields({
        vertex_document_index_ms: elapsedMs(startedAt),
        vertex_document_index_status: "success",
        vertex_document_index_chunks: totalChunks,
      });
      if (config.vertexSearchVerboseLoggingEnabled) {
        logger.info("Vertex document index completed", {
          event: "vertex_document_index",
          status: "success",
          duration_ms: Number(elapsedMs(startedAt).toFixed(2)),
          ...baseLogFields,
        });
      }
    } catch (error) {
      setRequestTimingFields({
        vertex_document_index_ms: elapsedMs(startedAt),
        vertex_document_index_status: "failed",
        vertex_document_index_chunks: totalChunks,
      });
      logger.warn("Vertex document index failed", {
        event: "vertex_document_index",
        status: "failed",
        duration_ms: Number(elapsedMs(startedAt).toFixed(2)),
        error: error instanceof Error ? error.message : String(error),
        ...baseLogFields,
      });
      throw error;
    }
  }

  async searchDocuments(query: string, auth: AuthContext, limit: number): Promise<DocumentSearchHit[]> {
    const startedAt = process.hrtime.bigint();
    if (!config.vertexDocumentSearchEnabled && !config.vertexDocumentSearchShadowEnabled) return [];
    const servingConfig = normalizeServingConfigResource(config.vertexSearchServingConfig);
    if (!servingConfig) {
      logger.warn("Vertex document search query skipped; serving config is not configured", {
        event: "vertex_document_search_query_skipped",
        tenant_id: auth.tenantId,
        user_id: auth.userId,
      });
      setRequestTimingFields({
        vertex_document_search_ms: elapsedMs(startedAt),
        vertex_document_search_status: "skipped_no_serving_config",
      });
      return [];
    }

    const dataStore = normalizeDataStoreResource(config.vertexSearchDataStore);
    const filter =
      `tenant_id: ANY("${quoteFilterLiteral(auth.tenantId)}") AND ` +
      `user_id: ANY("${quoteFilterLiteral(auth.userId)}")`;

    const payload: Record<string, unknown> = {
      query,
      pageSize: Math.min(20, Math.max(1, Math.floor(limit))),
      filter,
      contentSearchSpec: {
        snippetSpec: {
          returnSnippet: true,
        },
      },
    };
    if (dataStore) {
      payload["branch"] = buildBranchResource(dataStore);
    }
    const queryHash = shortHash(query);
    const limitClamped = Math.min(20, Math.max(1, Math.floor(limit)));
    const baseSearchTiming = {
      vertex_document_search_query_len: query.length,
      vertex_document_search_limit: limitClamped,
    };
    const baseSearchLogFields = {
      tenant_id: auth.tenantId,
      user_id: auth.userId,
      query_hash: queryHash,
      query_len: query.length,
      limit: limitClamped,
      serving_config: servingConfig,
      data_store: dataStore,
      branch: dataStore ? buildBranchResource(dataStore) : null,
      filter,
    };

    try {
      const response = await this.discoveryRequest<VertexSearchResponse>({
        url: `${DISCOVERY_ENGINE_BASE_URL}/${servingConfig}:search`,
        method: "POST",
        body: payload,
        timeoutMs: this.searchTimeoutMs,
        billingProject: this.billingProject(servingConfig),
      });

      const hitsByRef = new Map<string, DocumentSearchHit>();
      let backendResultCount = 0;
      let filteredOutCount = 0;
      let scopedChunkCount = 0;
      const rawResults = response.results ?? [];
      backendResultCount = rawResults.length;
      for (const result of rawResults) {
        const structData = result.document?.structData ?? result.chunk?.documentMetadata?.structData;
        if (!structData) continue;

        const tenant = typeof structData["tenant_id"] === "string" ? structData["tenant_id"] : "";
        const user = typeof structData["user_id"] === "string" ? structData["user_id"] : "";
        if (tenant !== auth.tenantId || user !== auth.userId) {
          filteredOutCount += 1;
          continue;
        }
        scopedChunkCount += 1;

        const ref = typeof structData["ref"] === "string"
          ? structData["ref"]
          : result.document?.id ?? result.id ?? result.chunk?.id ?? "";
        if (!ref) continue;

        const title = typeof structData["title"] === "string" && structData["title"].trim()
          ? structData["title"]
          : ref;
        const summary = typeof structData["summary"] === "string" ? structData["summary"] : "";

        const snippet =
          result.document?.derivedStructData?.snippets?.[0]?.snippet
          ?? result.chunk?.derivedStructData?.snippets?.[0]?.snippet
          ?? result.chunk?.content
          ?? summary;

        const candidate: DocumentSearchHit = {
          ref,
          title,
          score: modelScore(result),
          preview: stripHtml((snippet ?? "").toString()).slice(0, 400),
        };
        const current = hitsByRef.get(ref);
        if (!current || candidate.score > current.score) {
          hitsByRef.set(ref, candidate);
        } else if (!current.preview && candidate.preview) {
          current.preview = candidate.preview;
          hitsByRef.set(ref, current);
        }
      }
      const hits = [...hitsByRef.values()]
        .sort((left, right) => right.score - left.score);

      setRequestTimingFields({
        vertex_document_search_ms: elapsedMs(startedAt),
        vertex_document_search_status: "success",
        vertex_document_search_hits: hits.length,
        vertex_document_search_scoped_chunks: scopedChunkCount,
        vertex_document_search_backend_results: backendResultCount,
        vertex_document_search_filtered_out: filteredOutCount,
        ...baseSearchTiming,
      });
      if (config.vertexSearchVerboseLoggingEnabled) {
        logger.info("Vertex document search completed", {
          event: "vertex_document_search",
          status: "success",
          duration_ms: Number(elapsedMs(startedAt).toFixed(2)),
          backend_results: backendResultCount,
          scoped_chunks: scopedChunkCount,
          scoped_hits: hits.length,
          filtered_out: filteredOutCount,
          ...baseSearchLogFields,
        });
      }
      return hits.slice(0, Math.min(20, Math.max(1, Math.floor(limit))));
    } catch (error) {
      setRequestTimingFields({
        vertex_document_search_ms: elapsedMs(startedAt),
        vertex_document_search_status: "failed",
        ...baseSearchTiming,
      });
      logger.warn("Vertex document search failed", {
        event: "vertex_document_search",
        status: "failed",
        duration_ms: Number(elapsedMs(startedAt).toFixed(2)),
        error: error instanceof Error ? error.message : String(error),
        ...baseSearchLogFields,
      });
      throw error;
    }
  }

  private async discoveryRequest<T>(input: {
    url: string;
    method: "POST" | "PATCH";
    body: unknown;
    timeoutMs: number;
    billingProject: string | null;
  }): Promise<T> {
    const accessToken = await this.getAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await this.fetchImpl(input.url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(input.billingProject ? { "x-goog-user-project": input.billingProject } : {}),
        },
        body: JSON.stringify(input.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payloadText = await response.text();
        throw new Error(extractErrorMessage(response.status, payloadText));
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Discovery Engine request timed out after ${input.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private billingProject(resourceName: string): string | null {
    return config.googleProjectId || resourceProject(resourceName);
  }

  private async getAccessToken(): Promise<string> {
    const envToken = process.env.TALLEI_GOOGLE__ACCESS_TOKEN?.trim();
    if (envToken) return envToken;

    const now = Date.now();
    if (this.cachedAccessToken && now < this.cachedAccessTokenExpiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return this.cachedAccessToken;
    }

    if (this.tokenInFlight) {
      return this.tokenInFlight;
    }

    this.tokenInFlight = this.accessTokenProvider()
      .catch(async (error) => {
        // Local dev fallback: if not on Cloud Run metadata and no static token is set,
        // use ADC token from gcloud when available.
        if (config.nodeEnv === "production") {
          throw error;
        }
        return this.getAccessTokenFromGcloud(error);
      })
      .then((token) => {
        this.cachedAccessToken = token;
        this.cachedAccessTokenExpiresAtMs = now + 55 * 60 * 1000;
        return token;
      })
      .finally(() => {
        this.tokenInFlight = null;
      });

    return this.tokenInFlight;
  }

  private async getAccessTokenFromMetadata(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await this.fetchImpl(METADATA_TOKEN_ENDPOINT, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Metadata token endpoint failed with HTTP ${response.status}`);
      }
      const payload = await response.json() as TokenResponse;
      const token = payload.access_token?.trim();
      if (!token) {
        throw new Error("Metadata token endpoint response missing access_token");
      }
      const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3300;
      this.cachedAccessTokenExpiresAtMs = Date.now() + Math.max(60, expiresIn) * 1000;
      return token;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Metadata token endpoint timed out");
      }
      if (error instanceof Error) {
        throw new Error(
          `Metadata token lookup failed: ${error.message}. ` +
          `If running locally, set TALLEI_GOOGLE__ACCESS_TOKEN or run ` +
          `"gcloud auth application-default login" and ensure a quota project is set.`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getAccessTokenFromGcloud(cause: unknown): Promise<string> {
    const token = await new Promise<string>((resolve, reject) => {
      execFile(
        "gcloud",
        ["auth", "application-default", "print-access-token"],
        { timeout: GCLOUD_TOKEN_TIMEOUT_MS, maxBuffer: 32 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout.trim());
        }
      );
    }).catch((gcloudError) => {
      const causeMessage = cause instanceof Error ? cause.message : String(cause);
      const gcloudMessage = gcloudError instanceof Error ? gcloudError.message : String(gcloudError);
      throw new Error(
        `Google access token acquisition failed. Metadata cause: ${causeMessage}. ` +
        `gcloud fallback cause: ${gcloudMessage}.`
      );
    });

    if (!token) {
      throw new Error("gcloud printed an empty access token");
    }
    return token;
  }

  private isAlreadyExistsError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /HTTP 409|ALREADY_EXISTS/i.test(error.message);
  }
}
