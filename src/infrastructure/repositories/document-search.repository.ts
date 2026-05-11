import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { createLogger } from "../../observability/index.js";
import { setRequestTimingFields } from "../../observability/request-timing.js";

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

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

export class VertexDocumentSearchRepository implements DocumentSearchRepository {
  async indexDocument(input: DocumentSearchIndexInput): Promise<void> {
    const startedAt = process.hrtime.bigint();
    if (!config.vertexDocumentSearchEnabled && !config.vertexDocumentSearchShadowEnabled) return;
    if (!config.vertexSearchDataStore) {
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

    logger.info("Vertex document search indexing placeholder", {
      event: "vertex_document_search_index_placeholder",
      document_id: input.documentId,
      tenant_id: input.auth.tenantId,
      user_id: input.auth.userId,
      ref: input.ref,
      datastore: config.vertexSearchDataStore,
    });
    setRequestTimingFields({
      vertex_document_index_ms: elapsedMs(startedAt),
      vertex_document_index_status: "placeholder",
    });
  }

  async searchDocuments(query: string, auth: AuthContext, limit: number): Promise<DocumentSearchHit[]> {
    const startedAt = process.hrtime.bigint();
    if (!config.vertexDocumentSearchEnabled && !config.vertexDocumentSearchShadowEnabled) return [];
    if (!config.vertexSearchServingConfig) {
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

    logger.info("Vertex document search query placeholder", {
      event: "vertex_document_search_query_placeholder",
      tenant_id: auth.tenantId,
      user_id: auth.userId,
      query_length: query.length,
      limit,
      serving_config: config.vertexSearchServingConfig,
    });
    setRequestTimingFields({
      vertex_document_search_ms: elapsedMs(startedAt),
      vertex_document_search_status: "placeholder",
    });
    return [];
  }
}
