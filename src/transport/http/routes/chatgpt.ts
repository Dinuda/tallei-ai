import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest, requireScopes, safeSecretEqual } from "../middleware/auth.middleware.js";
import { config } from "../../../config/index.js";
import { assertUploadThingConfigured, UploadThingConfigError } from "../../../infrastructure/storage/uploadthing-client.js";
import { recallMemories, saveMemory, savePreference } from "../../../services/memory.js";
import {
  stashDocument,
  stashDocumentNote,
  recallDocument,
  searchDocuments,
  deleteDocumentByRef,
  recentDocumentBriefs,
  documentBriefsByRefs,
  DocumentSizeExceededError,
} from "../../../services/documents.js";
import { ingestUploadedFileToDocument, ingestUploadedFilesToDocuments } from "../../../services/uploaded-file-ingest.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import { authContextFromApiKey, authContextFromUserId } from "../../../infrastructure/auth/auth.js";
import { getPlanForTenant } from "../../../infrastructure/auth/tenancy.js";
import { validateOAuthAccessToken } from "../../../infrastructure/auth/oauth-tokens.js";
import { setRequestTimingField } from "../../../observability/request-timing.js";
import { runAsyncSafe } from "../../../shared/async-safe.js";
import {
  conversationIdSchema,
  normalizeUploadedFileRequestBody,
  openAiFileRefSchema,
  uploadBlobBodySchema,
} from "../schemas/uploaded-files.js";

const router = Router();
const memoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note"]);
const rememberKindSchema = z.enum(["fact", "preference", "document-note", "document-blob"]);

const recallSchema = z.object({
  query: z.string().trim().optional().default("latest user context, goals, preferences, and relevant prior facts"),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
  types: z.array(memoryTypeSchema).optional(),
  include_doc_refs: z.array(z.string()).max(20).optional(),
  openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
  conversation_id: conversationIdSchema,
});

const rememberSchema = z.object({
  kind: rememberKindSchema,
  content: z.string().optional(),
  title: z.string().optional(),
  key_points: z.array(z.string()).max(10).optional(),
  summary: z.string().optional(),
  source_hint: z.string().optional(),
  category: z.string().optional(),
  preference_key: z.string().optional(),
  platform: z.enum(["claude", "chatgpt", "gemini", "other"]).optional().default("chatgpt"),
  openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
  conversation_id: conversationIdSchema,
});

const undoSaveSchema = z.object({
  ref: z.string().min(1, "ref is required"),
});

const recentDocumentsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

const searchDocumentsSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

const recallDocumentSchema = z.object({
  ref: z.string().min(1, "ref is required"),
});

function isTransientMemoryInfraError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Qdrant|timeout|aborted|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|No route to host|connection error|fetch failed|APIConnectionError|EHOSTUNREACH|EAI_AGAIN/i.test(error.message);
}

function degradedRecallResponse() {
  return {
    contextBlock: "--- No relevant memories found ---",
    memories: [],
    recentDocuments: [],
    matchedDocuments: [],
    referencedDocuments: [],
    autoSave: {
      requested: 0,
      complete: true,
      saved: [],
      errors: [],
    },
  };
}

function recallTypesOrDefault(types?: Array<z.infer<typeof memoryTypeSchema>>): Array<z.infer<typeof memoryTypeSchema>> {
  if (types && types.length > 0) return types;
  return ["fact", "preference"];
}

// TODO: move somwhere else, dont have data layer in route handler file
async function logChatGptAction(input: {
  auth: AuthRequest["authContext"];
  method:
    | "chatgpt/actions/recall_memories"
    | "chatgpt/actions/remember"
    | "chatgpt/actions/upload_blob"
    | "chatgpt/actions/undo_save"
    | "chatgpt/actions/recent_documents"
    | "chatgpt/actions/search_documents"
    | "chatgpt/actions/recall_document";
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  const auth = input.auth;
  if (!auth) return;

  // TODO: see if you can multi-thread this or something if the db insert becomes a bottleneck. Dont want to lose events but also dont want to slow down the main request flow. Also will 
  // probably want to batch these up and do bulk inserts if traffic is high, expect 100k events/month at 10k users and 1-2 events per user per day.
  try {
    await pool.query(
      `INSERT INTO mcp_call_events (tenant_id, user_id, key_id, auth_mode, method, tool_name, ok, error)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
      [
        auth.tenantId,
        auth.userId,
        auth.keyId ?? null,
        auth.authMode,
        input.method,
        input.ok,
        input.error ?? null,
      ]
    );
  } catch (error) {
    if (config.nodeEnv !== "production") {
      console.error("[chatgpt] failed to persist action event:", error);
    }
  }
}

function logChatGptActionAsync(input: Parameters<typeof logChatGptAction>[0]): void {
  setRequestTimingField("event_log_mode", "async");
  runAsyncSafe(() => logChatGptAction(input), "chatgpt action event");
}

async function chatGptActionAuthMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authStartedAt = process.hrtime.bigint();
  // TODO: consider moving this to the observability layer as a general "auth timing" middleware since we will want to track auth performance for all endpoints, not just chatgpt actions. For now its only on chatgpt actions so its here.
  const noteAuthTiming = () => {
    const authMs = Number(process.hrtime.bigint() - authStartedAt) / 1_000_000;
    setRequestTimingField("auth_ms", authMs);
  };
  const internalSecret = req.headers["x-internal-secret"];
  if (internalSecret) {
    if (!safeSecretEqual(String(internalSecret), config.internalApiSecret)) {
      noteAuthTiming();
      res.status(401).json({ error: "Invalid internal secret" });
      return;
    }

    const userId = req.headers["x-user-id"] as string | undefined;
    if (!userId) {
      noteAuthTiming();
      res.status(400).json({ error: "Missing X-User-Id header" });
      return;
    }

    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    req.userId = userId;
    req.authContext = tenantId
      ? { userId, tenantId, authMode: "internal", plan: "free" as const }
      : await authContextFromUserId(userId, "internal");
    noteAuthTiming();
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    noteAuthTiming();
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    noteAuthTiming();
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const isLikelyApiKey = token.startsWith("tly_") || token.startsWith("gm_");

  if (isLikelyApiKey) {
    const apiKeyContext = await authContextFromApiKey(token, req.ip);
    if (apiKeyContext) {
      if (apiKeyContext.connectorType && apiKeyContext.connectorType !== "chatgpt") {
        noteAuthTiming();
        res.status(403).json({ error: "API key is not valid for ChatGPT actions" });
        return;
      }
      req.userId = apiKeyContext.userId;
      req.authContext = apiKeyContext;
      noteAuthTiming();
      next();
      return;
    }
  }

  try {
    const tokenContext = await validateOAuthAccessToken(token);
    if (!tokenContext) {
      noteAuthTiming();
      res.status(401).json({ error: "Invalid bearer token" });
      return;
    }

    const plan = await getPlanForTenant(tokenContext.tenantId);
    req.userId = tokenContext.userId;
    req.authContext = {
      userId: tokenContext.userId,
      tenantId: tokenContext.tenantId,
      authMode: "oauth",
      plan,
      clientId: tokenContext.clientId,
      scopes: tokenContext.scopes,
    };
    noteAuthTiming();
    next();
  } catch (error) {
    noteAuthTiming();
    console.error("ChatGPT action auth failed:", error);
    res.status(500).json({ error: "Server error validating bearer token" });
  }
}

export function buildOpenApiSpec(serverUrl: string) {
  const openAiFileRefJsonSchema = {
    type: "object",
    required: ["id", "download_link"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      mime_type: { type: "string" },
      download_link: { type: "string", format: "uri" },
    },
  };

  const canonicalUploadExample = {
    openaiFileIdRefs: [
      {
        id: "file_123",
        name: "Q2-report.pdf",
        mime_type: "application/pdf",
        download_link: "https://files.oaiusercontent.com/file-abc",
      },
    ],
    conversation_id: "conv_123",
  };

  const aliasUploadExample = {
    openai_file_id_refs: [
      {
        fileId: "file_456",
        filename: "brief.md",
        mimeType: "text/markdown",
        downloadLink: "https://files.oaiusercontent.com/file-def",
      },
    ],
    conversation_id: "conv_123",
  };

  const memoryResultSchema = {
    type: "object",
    required: ["success", "kind"],
    properties: {
      success: { type: "boolean" },
      kind: { type: "string", enum: ["fact", "preference", "document-note", "document-blob"] },
      memoryId: { type: "string" },
      title: { type: "string" },
      filename: { type: ["string", "null"] },
      summary: { type: "object", additionalProperties: true },
      ref: { type: "string" },
      status: { type: "string" },
      lotRef: { type: ["string", "null"] },
      conversation_id: { type: ["string", "null"] },
      blob: {
        type: ["object", "null"],
        properties: {
          provider: { type: "string", enum: ["uploadthing"] },
          key: { type: "string" },
          url: { type: "string" },
          source_file_id: { type: "string" },
        },
      },
      count: { type: "integer" },
      count_saved: { type: "integer" },
      count_failed: { type: "integer" },
      errors: {
        type: "array",
        items: {
          type: "object",
          required: ["file_id", "filename", "error"],
          properties: {
            file_id: { type: "string" },
            filename: { type: "string" },
            error: { type: "string" },
          },
        },
      },
      saved: {
        type: "array",
        items: {
          type: "object",
          required: ["ref", "status", "title", "filename"],
          properties: {
            ref: { type: "string" },
            status: { type: "string" },
            title: { type: "string" },
            filename: { type: ["string", "null"] },
            conversation_id: { type: ["string", "null"] },
            blob: {
              type: ["object", "null"],
              properties: {
                provider: { type: "string", enum: ["uploadthing"] },
                key: { type: "string" },
                url: { type: "string" },
                source_file_id: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  const uploadBlobResultSchema = {
    type: "object",
    required: ["success", "count_saved", "count_failed", "saved", "errors"],
    properties: {
      success: { type: "boolean" },
      count_saved: { type: "integer" },
      count_failed: { type: "integer" },
      saved: memoryResultSchema.properties.saved,
      errors: memoryResultSchema.properties.errors,
      error: { type: "string" },
    },
  };

  const documentBriefSchema = {
    type: "object",
    required: ["kind", "ref", "title", "status", "createdAt", "preview"],
    properties: {
      kind: { type: "string", enum: ["document"] },
      ref: { type: "string" },
      title: { type: "string" },
      filename: { type: ["string", "null"] },
      status: { type: "string", enum: ["pending", "ready", "failed"] },
      createdAt: { type: "string" },
      preview: { type: "string" },
      lotRef: { type: ["string", "null"] },
      lotTitle: { type: ["string", "null"] },
    },
  };

  const lotBriefSchema = {
    type: "object",
    required: ["kind", "ref", "title", "createdAt", "documentCount", "documents"],
    properties: {
      kind: { type: "string", enum: ["lot"] },
      ref: { type: "string" },
      title: { type: "string" },
      createdAt: { type: "string" },
      documentCount: { type: "integer" },
      documents: {
        type: "array",
        items: documentBriefSchema,
      },
    },
  };

  const missingRefSchema = {
    type: "object",
    required: ["kind", "ref", "error"],
    properties: {
      kind: { type: "string", enum: ["missing"] },
      ref: { type: "string" },
      error: { type: "string" },
    },
  };

  const recallResultSchema = {
    type: "object",
    required: ["contextBlock", "memories", "recentDocuments", "matchedDocuments", "referencedDocuments", "autoSave"],
    properties: {
      contextBlock: { type: "string" },
      memories: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "text", "score", "metadata"],
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            score: { type: "number" },
            metadata: {
              type: "object",
              additionalProperties: true,
            },
          },
        },
      },
      recentDocuments: {
        type: "array",
        items: documentBriefSchema,
      },
      matchedDocuments: {
        type: "array",
        items: {
          type: "object",
          required: ["ref", "title", "score", "preview"],
          properties: {
            ref: { type: "string" },
            title: { type: "string" },
            score: { type: "number" },
            preview: { type: "string" },
          },
        },
      },
      referencedDocuments: {
        type: "array",
        items: {
          oneOf: [documentBriefSchema, lotBriefSchema, missingRefSchema],
        },
      },
      autoSave: {
        type: "object",
        required: ["requested", "complete", "saved", "errors"],
        properties: {
          requested: { type: "integer" },
          complete: { type: "boolean" },
          saved: {
            type: "array",
            items: {
              type: "object",
              required: ["ref", "status", "title", "filename", "conversation_id", "blob"],
              properties: {
                ref: { type: "string" },
                status: { type: "string" },
                title: { type: "string" },
                filename: { type: ["string", "null"] },
                conversation_id: { type: ["string", "null"] },
                blob: {
                  type: "object",
                  required: ["provider", "key", "url", "source_file_id"],
                  properties: {
                    provider: { type: "string", enum: ["uploadthing"] },
                    key: { type: "string" },
                    url: { type: "string" },
                    source_file_id: { type: "string" },
                  },
                },
              },
            },
          },
          errors: {
            type: "array",
            items: {
              type: "object",
              required: ["file_id", "filename", "error"],
              properties: {
                file_id: { type: "string" },
                filename: { type: "string" },
                error: { type: "string" },
              },
            },
          },
        },
      },
      autoSaveNotice: { type: "string" },
    },
  };

  const documentRecallSchema = {
    type: "object",
    required: ["kind", "ref", "filename", "title", "content", "status"],
    properties: {
      kind: { type: "string", enum: ["document"] },
      ref: { type: "string" },
      filename: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      content: { type: "string" },
      status: { type: "string", enum: ["ready", "pending_embedding", "failed_indexing"] },
    },
  };

  const lotRecallSchema = {
    type: "object",
    required: ["kind", "ref", "title", "docs"],
    properties: {
      kind: { type: "string", enum: ["lot"] },
      ref: { type: "string" },
      title: { type: ["string", "null"] },
      docs: {
        type: "array",
        items: {
          type: "object",
          required: ["ref", "filename", "title", "content", "status"],
          properties: {
            ref: { type: "string" },
            filename: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            content: { type: "string" },
            status: { type: "string", enum: ["ready", "pending_embedding", "failed_indexing"] },
          },
        },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Tallei ChatGPT Actions API",
      version: "2026-04-21",
      description:
        "Docs-lite shared-memory Actions API for ChatGPT Custom GPTs (Bearer API key). " +
        "OpenAPI operation descriptions are the canonical execution contract.",
    },
    servers: [
      {
        url: serverUrl,
      },
    ],
    components: {
      schemas: {},
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API key",
          description: "Use your ChatGPT Action bearer key from /dashboard/setup.",
        },
      },
    },
    paths: {
      "/api/chatgpt/actions/recall_memories": {
        post: {
          operationId: "recall_memories",
          summary: "First turn required; later turns conditional recall",
          description:
            "NON-NEGOTIABLE: first user turn must call this. Later turns call only when asked or context is missing. " +
            "If files exist, do not answer yet: upload_blob (wait), then recall_memories if needed, then answer. " +
            "Mini/auto guard: if unsure, call tools before answering.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description:
                        "Lookup query derived from the current user prompt. If omitted, the service uses a generic context-loading query.",
                    },
                    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
                    types: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: ["preference", "fact", "event", "decision", "note"],
                      },
                      description: "Optional memory type scope. Defaults to [fact, preference] when omitted.",
                    },
                    include_doc_refs: {
                      type: "array",
                      items: { type: "string" },
                      description: "Optional @doc/@lot refs to include as brief metadata (no full content).",
                    },
                    openaiFileIdRefs: {
                      type: "array",
                      description:
                        "Canonical upload refs. Aliases are accepted by the server, but this canonical field should be preferred.",
                      items: openAiFileRefJsonSchema,
                    },
                    conversation_id: {
                      type: "string",
                      description: "Optional client-provided conversation identifier to link uploaded files to a conversation.",
                    },
                  },
                },
                examples: {
                  canonical: {
                    summary: "Canonical upload refs",
                    value: {
                      query: "Summarize this uploaded report",
                      ...canonicalUploadExample,
                    },
                  },
                  alias: {
                    summary: "Alias upload refs (accepted)",
                    value: {
                      query: "Summarize this uploaded report",
                      attachments: aliasUploadExample.openai_file_id_refs,
                      conversation_id: "conv_123",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Memory recall results, plus auto-saved document refs if files were uploaded",
              content: {
                "application/json": {
                  schema: recallResultSchema,
                },
              },
            },
            "422": {
              description: "Uploaded file ingestion failed. Retry upload_blob before answering.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["error", "autoSave"],
                    properties: {
                      error: { type: "string" },
                      autoSave: recallResultSchema.properties.autoSave,
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/upload_blob": {
        post: {
          operationId: "upload_blob",
          summary: "REQUIRED first step for uploaded files: save full files before answering",
          description:
            "NON-NEGOTIABLE for file turns: call first and wait before any answer. Supports PDF and Word (.docx/.docm). " +
            "Do not use direct attachment text before save. User text rule: start with I'm saving \"<file_name>\" and end with saved @doc/@lot link. " +
            "Retry/report any failure.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["openaiFileIdRefs"],
                  properties: {
                    openaiFileIdRefs: {
                      type: "array",
                      items: openAiFileRefJsonSchema,
                    },
                    conversation_id: {
                      type: "string",
                      description: "Optional client-provided conversation identifier to link uploaded files to a conversation.",
                    },
                    title: {
                      type: "string",
                      description: "Optional override title applied to uploaded file saves.",
                    },
                  },
                },
                examples: {
                  canonical: {
                    summary: "Canonical upload payload",
                    value: canonicalUploadExample,
                  },
                  alias: {
                    summary: "Alias payload accepted by server",
                    value: aliasUploadExample,
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "All uploaded files persisted successfully.",
              content: {
                "application/json": {
                  schema: uploadBlobResultSchema,
                },
              },
            },
            "422": {
              description: "One or more files failed; inspect saved/errors and retry failed files.",
              content: {
                "application/json": {
                  schema: uploadBlobResultSchema,
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/remember": {
        post: {
          operationId: "remember",
          summary: "Unified save endpoint for memory and documents (supports uploaded files)",
          description:
            "Use for explicit saves and cadence: every 3 user messages, save a concise fact summary unless user opts out. " +
            "For files, upload_blob must run first and complete. If persistence fails, return failure and never claim success.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["kind"],
                  properties: {
                    kind: { type: "string", enum: ["fact", "preference", "document-note", "document-blob"] },
                    content: { type: "string" },
                    title: { type: "string" },
                    key_points: { type: "array", items: { type: "string" }, maxItems: 10 },
                    summary: { type: "string" },
                    source_hint: { type: "string" },
                    category: { type: "string" },
                    preference_key: { type: "string" },
                    platform: { type: "string", enum: ["claude", "chatgpt", "gemini", "other"] },
                    openaiFileIdRefs: {
                      type: "array",
                      description:
                        "Canonical upload refs. Aliases are accepted, but this canonical field should be preferred.",
                      items: openAiFileRefJsonSchema,
                    },
                    conversation_id: {
                      type: "string",
                      description: "Optional client-provided conversation identifier to link uploaded files to a conversation.",
                    },
                  },
                },
                examples: {
                  canonical: {
                    summary: "Canonical remember upload payload",
                    value: {
                      kind: "document-note",
                      ...canonicalUploadExample,
                    },
                  },
                  alias: {
                    summary: "Alias remember upload payload",
                    value: {
                      kind: "document-note",
                      files: aliasUploadExample.openai_file_id_refs,
                      conversation_id: "conv_123",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Saved",
              content: {
                "application/json": {
                  schema: memoryResultSchema,
                },
              },
            },
            "422": {
              description: "One or more uploaded files failed to persist.",
              content: {
                "application/json": {
                  schema: memoryResultSchema,
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/undo_save": {
        post: {
          operationId: "undo_save",
          summary: "Delete an auto-saved document by @doc/@lot ref",
          "x-openai-isConsequential": true,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ref"],
                  properties: {
                    ref: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["success", "ref", "type"],
                    properties: {
                      success: { type: "boolean" },
                      ref: { type: "string" },
                      type: { type: "string", enum: ["document", "lot"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/chatgpt/actions/recent_documents": {
        post: {
          operationId: "recent_documents",
          summary: "Step 1 for document-grounded questions: fetch latest doc briefs",
          description:
            "Use first when the question may reference prior uploads, even if the user does not explicitly say 'PDF' or 'document'.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Recent document briefs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["documents", "count"],
                    properties: {
                      documents: {
                        type: "array",
                        items: documentBriefSchema,
                      },
                      count: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/chatgpt/actions/search_documents": {
        post: {
          operationId: "search_documents",
          summary: "Step 2 for document-grounded questions: search older docs",
          description:
            "Use when recent_documents is insufficient or no obvious match. Query should be the raw user question.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string" },
                    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Search hits",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["matches", "count"],
                    properties: {
                      matches: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["ref", "title", "score", "preview"],
                          properties: {
                            ref: { type: "string" },
                            title: { type: "string" },
                            score: { type: "number" },
                            preview: { type: "string" },
                          },
                        },
                      },
                      count: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/chatgpt/actions/recall_document": {
        post: {
          operationId: "recall_document",
          summary: "Step 3 for document-grounded questions: fetch full matching content",
          description:
            "Use after recent_documents/search_documents finds a likely match. Do not skip lookup and answer generically.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ref"],
                  properties: {
                    ref: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Full document content",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [documentRecallSchema, lotRecallSchema],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function sendOpenApiSpec(res: Response): void {
  let serverUrl: string;
  try {
    const base = new URL(config.publicBaseUrl);
    serverUrl = `${base.protocol}//${base.host}`;
  } catch {
    serverUrl = "http://127.0.0.1:3000";
  }

  res.json(buildOpenApiSpec(serverUrl));
}

router.get("/openapi.json", (_req, res: Response) => {
  sendOpenApiSpec(res);
});

router.get("/actions/openapi.json", (_req, res: Response) => {
  sendOpenApiSpec(res);
});

router.post("/actions/recall_memories", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = recallSchema.parse(normalizeUploadedFileRequestBody(req.body ?? {}));
    const [result, recentDocuments, matchedDocuments] = await Promise.all([
      recallMemories(body.query, req.authContext!, body.limit, req.ip, {
        types: recallTypesOrDefault(body.types),
      }),
      recentDocumentBriefs(req.authContext!, 5),
      searchDocuments(body.query, req.authContext!, 3).catch(() => []),
    ]);
    const refs = [...new Set((body.include_doc_refs ?? []).map((value) => value.trim()).filter(Boolean))];
    const referencedDocuments = refs.length > 0
      ? await documentBriefsByRefs(refs, req.authContext!, { maxLotDocs: 5 })
      : [];

    // --- Server-side auto-save of uploaded files ---
    const uploadedFiles = body.openaiFileIdRefs ?? [];
    const autoSaved: Array<{
      ref: string;
      status: string;
      title: string;
      filename: string | null;
      conversation_id: string | null;
      blob: { provider: "uploadthing"; key: string; url: string; source_file_id: string };
    }> = [];
    const autoSaveErrors: Array<{ file_id: string; filename: string; error: string }> = [];
    if (uploadedFiles.length > 0 && req.authContext) {
      assertUploadThingConfigured();
      for (const fileRef of uploadedFiles) {
        try {
          const saved = await ingestUploadedFileToDocument(fileRef, req.authContext!, {
            conversation_id: body.conversation_id ?? null,
          });
          autoSaved.push({
            ref: saved.ref,
            status: saved.status,
            title: saved.title,
            filename: saved.filename,
            conversation_id: saved.conversation_id,
            blob: saved.blob,
          });
        } catch (fileErr) {
          const errMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
          console.error(`[chatgpt] auto-save file ${fileRef.id} failed:`, errMsg);
          autoSaveErrors.push({ file_id: fileRef.id, filename: fileRef.name ?? fileRef.id, error: errMsg });
        }
      }
    }

    if (uploadedFiles.length > 0 && autoSaveErrors.length > 0) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/recall_memories",
        ok: false,
        error: `${autoSaveErrors.length} uploaded file(s) failed to persist`,
      });
      res.status(422).json({
        error: "One or more uploaded files failed to save. Retry upload_blob before answering.",
        autoSave: {
          requested: uploadedFiles.length,
          complete: false,
          saved: autoSaved,
          errors: autoSaveErrors,
        },
      });
      return;
    }

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/recall_memories",
      ok: true,
    });
    res.json({
      ...result,
      recentDocuments,
      matchedDocuments,
      referencedDocuments,
      autoSave: {
        requested: uploadedFiles.length,
        complete: autoSaveErrors.length === 0,
        saved: autoSaved,
        errors: autoSaveErrors,
      },
      ...(autoSaved.length > 0 ? {
        autoSaved,
        autoSaveNotice: `📎 Auto-saved ${autoSaved.length} file(s) to Tallei: ${autoSaved.map(s => `${s.title} → ${s.ref}`).join(", ")}. User can reply "undo" to delete.`,
      } : {}),
      ...(autoSaveErrors.length > 0 ? { autoSaveErrors } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (isTransientMemoryInfraError(error)) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/recall_memories",
        ok: false,
        error: error instanceof Error ? error.message : "Transient memory infra error",
      });
      res.json(degradedRecallResponse());
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/recall_memories",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to recall memories",
    });
    console.error("Error recalling ChatGPT memories:", error);
    res.status(500).json({ error: "Failed to recall memories" });
  }
});

router.post("/actions/remember", chatGptActionAuthMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = rememberSchema.parse(normalizeUploadedFileRequestBody(req.body ?? {}));
    const uploadedFiles = body.openaiFileIdRefs ?? [];

    if (uploadedFiles.length > 0) {
      if (body.kind !== "document-note" && body.kind !== "document-blob") {
        res.status(400).json({ error: "openaiFileIdRefs can only be used with kind=document-note or kind=document-blob" });
        return;
      }

      assertUploadThingConfigured();

      const savedFromFiles: Array<{
        ref: string;
        status: string;
        title: string;
        filename: string | null;
        type: "note" | "blob";
        conversation_id: string | null;
        blob: { provider: "uploadthing"; key: string; url: string; source_file_id: string } | null;
      }> = [];
      const fileErrors: Array<{ file_id: string; filename: string; error: string }> = [];
      for (const fileRef of uploadedFiles) {
        try {
          // 1. Save the note using ChatGPT's summary (no local summarization)
          if (body.kind === "document-note") {
            const noteResult = await stashDocumentNote({
              title: body.title ?? fileRef.name ?? "Uploaded Document",
              key_points: body.key_points ?? [],
              summary: body.summary ?? "",
              source_hint: body.source_hint ?? `Uploaded via ChatGPT — ${fileRef.name || fileRef.id}`,
            }, req.authContext!, { conversationId: body.conversation_id ?? null });
            savedFromFiles.push({
              ref: noteResult.refHandle,
              status: noteResult.status,
              title: body.title ?? fileRef.name ?? "Uploaded Document",
              filename: fileRef.name ?? null,
              type: "note",
              conversation_id: body.conversation_id ?? null,
              blob: null,
            });
          }

          // 2. Download, upload full file as blob, then stash parsed text
          const blobSaved = await ingestUploadedFileToDocument(fileRef, req.authContext!, {
            title: body.title,
            conversation_id: body.conversation_id ?? null,
          });
          savedFromFiles.push({
            ref: blobSaved.ref,
            status: blobSaved.status,
            title: blobSaved.title,
            filename: blobSaved.filename,
            type: "blob",
            conversation_id: blobSaved.conversation_id,
            blob: blobSaved.blob,
          });
        } catch (fileErr) {
          const errMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
          console.error(`[chatgpt] remember file ${fileRef.id} failed:`, errMsg);
          fileErrors.push({
            file_id: fileRef.id,
            filename: fileRef.name ?? fileRef.id,
            error: errMsg,
          });
        }
      }

      if (fileErrors.length > 0) {
        logChatGptActionAsync({
          auth: req.authContext,
          method: "chatgpt/actions/remember",
          ok: false,
          error: `${fileErrors.length} uploaded file(s) failed to persist`,
        });
        res.status(422).json({
          success: false,
          kind: body.kind,
          error: "One or more files failed to save.",
          count_saved: savedFromFiles.length,
          count_failed: fileErrors.length,
          saved: savedFromFiles,
          errors: fileErrors,
        });
        return;
      }

      logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/remember", ok: true });

      const first = savedFromFiles[0];
      if (savedFromFiles.length === 1 && first) {
        res.json({
          success: true,
          kind: body.kind,
          ref: first.ref,
          status: first.status,
          title: first.title,
          filename: first.filename,
          conversation_id: first.conversation_id,
          blob: first.blob,
        });
        return;
      }

      res.json({
        success: true,
        kind: body.kind,
        count: savedFromFiles.length,
        saved: savedFromFiles,
      });
      return;
    }

    if (body.kind === "fact") {
      if (!body.content) {
        res.status(400).json({ error: "content is required for kind=fact" });
        return;
      }
      const saved = await saveMemory(body.content, req.authContext!, body.platform ?? "chatgpt", req.ip);
      logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/remember", ok: true });
      res.json({
        success: true,
        kind: body.kind,
        memoryId: saved.memoryId,
        title: saved.title,
        summary: saved.summary,
      });
      return;
    }

    if (body.kind === "preference") {
      if (!body.content) {
        res.status(400).json({ error: "content is required for kind=preference" });
        return;
      }
      const saved = await savePreference(body.content, req.authContext!, body.platform ?? "chatgpt", req.ip, {
        category: body.category ?? null,
        preferenceKey: body.preference_key ?? null,
      });
      logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/remember", ok: true });
      res.json({
        success: true,
        kind: body.kind,
        memoryId: saved.memoryId,
        title: saved.title,
        summary: saved.summary,
      });
      return;
    }

    if (body.kind === "document-note") {
      const saved = await stashDocumentNote({
        title: body.title ?? "Untitled Note",
        key_points: body.key_points ?? [],
        summary: body.summary ?? "",
        source_hint: body.source_hint ?? "",
      }, req.authContext!, { conversationId: body.conversation_id ?? null });
      logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/remember", ok: true });
      res.json({
        success: true,
        kind: body.kind,
        ref: saved.refHandle,
        status: saved.status,
        conversation_id: body.conversation_id ?? null,
        blob: null,
      });
      return;
    }

    if (!body.content) {
      res.status(400).json({ error: "content is required for kind=document-blob" });
      return;
    }
    const saved = await stashDocument(body.content, req.authContext!, { title: body.title ?? undefined });
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/remember", ok: true });
    res.json({
      success: true,
      kind: body.kind,
      ref: saved.refHandle,
      status: saved.status,
      lotRef: saved.lotRef ?? null,
      conversation_id: saved.conversationId,
      blob: saved.blob ? {
        provider: saved.blob.provider,
        key: saved.blob.key,
        url: saved.blob.url,
        source_file_id: saved.blob.sourceFileId,
      } : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    if (error instanceof DocumentSizeExceededError) {
      res.status(413).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/remember",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to remember",
    });
    console.error("Error saving ChatGPT remember action:", error);
    res.status(500).json({ error: "Failed to remember" });
  }
});

router.post("/actions/upload_blob", chatGptActionAuthMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = uploadBlobBodySchema.parse(normalizeUploadedFileRequestBody(req.body ?? {}));
    assertUploadThingConfigured();

    const { saved, errors } = await ingestUploadedFilesToDocuments(body.openaiFileIdRefs, req.authContext!, {
      title: body.title,
      conversation_id: body.conversation_id ?? null,
    });

    if (errors.length > 0) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/upload_blob",
        ok: false,
        error: `${errors.length} uploaded file(s) failed to persist`,
      });
      res.status(422).json({
        success: false,
        error: "One or more files failed to save.",
        count_saved: saved.length,
        count_failed: errors.length,
        saved,
        errors,
      });
      return;
    }

    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/upload_blob", ok: true });
    res.json({
      success: true,
      count_saved: saved.length,
      count_failed: 0,
      saved,
      errors: [],
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    if (error instanceof DocumentSizeExceededError) {
      res.status(413).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/upload_blob",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to upload blobs",
    });
    console.error("Error uploading ChatGPT file blobs:", error);
    res.status(500).json({ error: "Failed to upload file blobs" });
  }
});

router.post("/actions/undo_save", chatGptActionAuthMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = undoSaveSchema.parse(req.body);
    const deleted = await deleteDocumentByRef(body.ref, req.authContext!);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/undo_save", ok: true });
    res.json({ success: true, ref: body.ref, type: deleted.type });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/undo_save",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to undo save",
    });
    console.error("Error undoing ChatGPT saved document:", error);
    res.status(500).json({ error: "Failed to undo save" });
  }
});

router.post("/actions/recent_documents", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = recentDocumentsSchema.parse(req.body ?? {});
    const documents = await recentDocumentBriefs(req.authContext!, body.limit);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/recent_documents", ok: true });
    res.json({ documents, count: documents.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/recent_documents",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to load recent documents",
    });
    console.error("Error loading recent ChatGPT documents:", error);
    res.status(500).json({ error: "Failed to load recent documents" });
  }
});

router.post("/actions/search_documents", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = searchDocumentsSchema.parse(req.body);
    const matches = await searchDocuments(body.query, req.authContext!, body.limit);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/search_documents", ok: true });
    res.json({ matches, count: matches.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/search_documents",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to search documents",
    });
    console.error("Error searching ChatGPT documents:", error);
    res.status(500).json({ error: "Failed to search documents" });
  }
});

router.post("/actions/recall_document", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = recallDocumentSchema.parse(req.body);
    const document = await recallDocument(body.ref, req.authContext!);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/recall_document", ok: true });
    res.json(document);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/recall_document",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to recall document",
    });
    console.error("Error recalling ChatGPT document:", error);
    res.status(500).json({ error: "Failed to recall document" });
  }
});

export default router;
