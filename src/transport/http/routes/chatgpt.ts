import { Router, Response } from "express";
import { z } from "zod";
import { AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { config } from "../../../config/index.js";
import { CHATGPT_OPENAPI_VERSION } from "../../shared/integration-assets.js";
import { UploadThingConfigError } from "../../../infrastructure/storage/uploadthing-client.js";
import { DocumentSizeExceededError } from "../../../services/documents.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import {
  conversationIdSchema,
  normalizeUploadedFileRequestBody,
  openAiFileRefSchema,
  uploadBlobBodySchema,
} from "../schemas/uploaded-files.js";
import {
  degradedRecallResponse,
  executePrepareResponseAction,
  executeRecallAction,
  executeRecallDocumentAction,
  executeRecentDocumentsAction,
  executeRememberAction,
  executeSearchDocumentsAction,
  executeUndoSaveAction,
  executeUploadBlobAction,
  executeUploadStatusAction,
  isTransientMemoryInfraError,
} from "../../shared/chat-actions.js";
import { logChatGptActionAsync } from "../../shared/chatgpt-action-events.js";
import { chatGptActionAuthMiddleware, resolveChatGptActionAuth } from "../auth/chatgpt-action-auth.js";

function zodValidationResponseBody(error: z.ZodError, received?: unknown) {
  return {
    error: "validation_failed",
    issues: error.issues,
    ...(received !== undefined ? { received } : {}),
  };
}

const router = Router();
const memoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note", "lesson", "failure", "checkpoint"]);
const rememberKindSchema = z.enum(["fact", "preference", "document-note", "document-blob"]);

const prepareResponseSchema = z.object({
  message: z.string().trim().min(1, "message is required"),
  openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
  conversation_id: conversationIdSchema,
  conversation_history: z.array(z.object({
    role: z.enum(["user", "assistant", "system", "tool"]).optional(),
    content: z.string().trim().min(1),
  })).max(40).optional(),
  handoff_target: z.enum(["claude", "chatgpt"]).optional().nullable(),
  last_recall: z.object({
    query: z.string().optional(),
    context_hash: z.string().optional(),
  }).optional().nullable(),
});

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

const uploadStatusQuerySchema = z.object({
  ref: z.string().trim().min(1, "ref is required"),
});


const DOCUMENT_SHARING_BILLING_URL = `${config.dashboardBaseUrl.replace(/\/$/, "")}/billing`;

type PlanRequiredActionErrorBody = {
  error: string;
  code: "plan_required";
  feature: "documents";
  billing_url: string;
  user_message: string;
};

function planRequiredActionError(error: PlanRequiredError): PlanRequiredActionErrorBody {
  return {
    error: error.message,
    code: "plan_required",
    feature: "documents",
    billing_url: DOCUMENT_SHARING_BILLING_URL,
    user_message: `This document action is not available on your current plan. Visit ${DOCUMENT_SHARING_BILLING_URL} to manage billing, then retry.`,
  };
}

export function buildOpenApiSpec(serverUrl: string) {
  const openAiFileRefJsonSchema = {
    type: "string",
    description:
      "ChatGPT file reference. The OpenAPI schema must use string items; at runtime ChatGPT sends JSON objects with id, name, mime_type, and a temporary download_link URL.",
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
        filename: "brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
      summary: { oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }, { type: "null" }] },
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
      saved: {
        type: "array",
        items: {
          type: "object",
          required: ["ref", "status", "filename", "conversation_id"],
          properties: {
            ref: { type: "string" },
            status: { type: "string", enum: ["pending"] },
            filename: { type: "string" },
            conversation_id: { type: ["string", "null"] },
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
      error: { type: "string" },
    },
  };

  const uploadIngestJobStatusSchema = {
    type: "object",
    required: ["ref", "status", "filename", "openai_file_id", "created_at"],
    properties: {
      ref: { type: "string" },
      status: { type: "string", enum: ["pending", "done", "failed"] },
      filename: { type: "string" },
      openai_file_id: { type: "string" },
      mime_type: { type: ["string", "null"] },
      conversation_id: { type: ["string", "null"] },
      created_at: { type: "string" },
      completed_at: { type: ["string", "null"] },
      error: { type: ["string", "null"] },
      document: {
        type: ["object", "null"],
        properties: {
          ref: { type: "string" },
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
    required: ["contextBlock", "memories", "recentDocuments", "matchedDocuments", "referencedDocuments", "recentCompletedIngests", "autoSave"],
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
      recentCompletedIngests: {
        type: "array",
        items: uploadIngestJobStatusSchema,
      },
      autoSave: {
        type: "object",
        required: ["requested", "complete", "saved", "errors"],
        properties: {
          requested: { type: "integer" },
          complete: { type: "boolean" },
          saved: uploadBlobResultSchema.properties.saved,
          errors: uploadBlobResultSchema.properties.errors,
        },
      },
    },
  };

  const prepareIntentSchema = {
    type: "object",
    required: ["needsRecall", "needsDocumentLookup", "reusePreviousContext", "contextDependent", "saveCandidates"],
    properties: {
      needsRecall: { type: "boolean" },
      needsDocumentLookup: { type: "boolean" },
      reusePreviousContext: { type: "boolean" },
      contextDependent: { type: "boolean" },
      saveCandidates: {
        type: "array",
        items: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["fact", "preference", "document-note"] },
            content: { type: "string" },
            title: { type: "string" },
            key_points: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            source_hint: { type: "string" },
            category: { type: "string" },
            preference_key: { type: "string" },
          },
        },
      },
    },
  };

  const prepareResponseSchema = {
    type: "object",
    required: ["contextBlock", "memories", "recentDocuments", "matchedDocuments", "referencedDocuments", "recentCompletedIngests", "inlineDocuments", "queuedSaves", "autoSave", "replyInstructions", "intent"],
    properties: {
      contextBlock: { type: "string" },
      memories: recallResultSchema.properties.memories,
      recentDocuments: recallResultSchema.properties.recentDocuments,
      matchedDocuments: recallResultSchema.properties.matchedDocuments,
      referencedDocuments: recallResultSchema.properties.referencedDocuments,
      recentCompletedIngests: recallResultSchema.properties.recentCompletedIngests,
      inlineDocuments: {
        type: "array",
        items: {
          type: "object",
          required: ["ref", "title", "content"],
          properties: {
            ref: { type: "string" },
            title: { type: ["string", "null"] },
            content: { type: "string" },
          },
        },
      },
      queuedSaves: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "status"],
          properties: {
            kind: { type: "string", enum: ["fact", "preference", "document-note"] },
            content: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["queued"] },
          },
        },
      },
      autoSave: recallResultSchema.properties.autoSave,
      replyInstructions: { type: "array", items: { type: "string" } },
      intent: prepareIntentSchema,
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

  const planRequiredErrorSchema = {
    type: "object",
    required: ["error", "code", "feature", "billing_url", "user_message"],
    properties: {
      error: { type: "string" },
      code: { type: "string", enum: ["plan_required"] },
      feature: { type: "string", enum: ["documents"] },
      billing_url: { type: "string", format: "uri" },
      user_message: { type: "string" },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Tallei ChatGPT Actions API",
      version: CHATGPT_OPENAPI_VERSION,
      description:
        "Docs-lite shared-memory Actions API for ChatGPT Custom GPTs (Bearer API key). " +
        "Call prepare_response on every turn; include openaiFileIdRefs with temporary HTTPS file URLs when attachments are visible.",
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
      "/api/chatgpt/actions/prepare_response": {
        post: {
          operationId: "prepare_response",
          summary: "PRIMARY ACTION: prepare context and queue saves",
          description:
            "Call every turn. Include openaiFileIdRefs with temporary HTTPS download_link URLs for visible attachments; use [] only when none are visible.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message", "openaiFileIdRefs"],
                  properties: {
                    message: {
                      type: "string",
                      description: "Exact current user message.",
                    },
                    conversation_id: {
                      type: "string",
                      description: "Optional client-provided conversation identifier.",
                    },
                    conversation_history: {
                      type: "array",
                      maxItems: 40,
                      description: "Visible ChatGPT conversation history as structured {role, content} messages. Required for handoff-to-Claude requests so Tallei can store context before Claude continues.",
                      items: {
                        type: "object",
                        required: ["content"],
                        properties: {
                          role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
                          content: { type: "string" },
                        },
                      },
                    },
                    handoff_target: {
                      type: "string",
                      enum: ["claude", "chatgpt"],
                      description: "Set when the user asks to hand off the visible chat context to another provider.",
                    },
                    openaiFileIdRefs: {
                      type: "array",
                      maxItems: 10,
                      default: [],
                      description: "Required array. Include every visible current-turn attachment. ChatGPT must populate this from attached files; use [] only when no attachments are visible. Runtime values arrive as objects with temporary HTTPS download_link URLs.",
                      items: openAiFileRefJsonSchema,
                    },
                    last_recall: {
                      type: "object",
                      properties: {
                        query: { type: "string" },
                        context_hash: { type: "string" },
                      },
                    },
                  },
                },
                examples: {
                  message: {
                    summary: "Prepare answer context",
                    value: {
                      message: "What did we decide about the onboarding flow?",
                      openaiFileIdRefs: [],
                      conversation_id: "conv_123",
                    },
                  },
                  upload: {
                    summary: "Prepare answer with attachment",
                    value: {
                      message: "Summarize this uploaded report",
                      ...canonicalUploadExample,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Prepared context, queued saves, and reply instructions.",
              content: {
                "application/json": {
                  schema: prepareResponseSchema,
                },
              },
            },
            "422": {
              description: "Uploaded file ingestion failed; inspect autoSave errors.",
              content: {
                "application/json": {
                  schema: prepareResponseSchema,
                },
              },
            },
            "402": {
              description: "Plan upgrade required for document sharing. Ask user to pay at billing_url; do not retry uploads.",
              content: {
                "application/json": {
                  schema: planRequiredErrorSchema,
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/recall_memories": {
        post: {
          operationId: "recall_memories",
          summary: "Fallback memory/document recall; prefer prepare_response",
          description:
            "Fallback direct recall for legacy GPTs or debugging. For normal ChatGPT flow, call prepare_response before the final answer instead of direct recall/remember orchestration.",
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
            "402": {
              description: "Plan upgrade required for document sharing. Ask user to pay at billing_url; do not retry uploads.",
              content: {
                "application/json": {
                  schema: planRequiredErrorSchema,
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
          summary: "Fallback upload retry — only if recall_memories autoSave failed",
          description:
            "Fallback tool. Use only when recall_memories reports autoSave.complete=false or 422. Pass failed files in openaiFileIdRefs and retry once on 422. If 402 code=plan_required, stop retries and ask user to upgrade via billing_url. Supports only PDF and Word (.docx/.docm) file ingest.",
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
            "402": {
              description: "Plan upgrade required for document sharing. Ask user to pay at billing_url; do not retry uploads.",
              content: {
                "application/json": {
                  schema: planRequiredErrorSchema,
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/upload_status": {
        get: {
          operationId: "upload_status",
          summary: "Poll status for an uploaded file ingest job",
          description:
            "Use this after upload_blob handoff to check pending/done/failed for a ref.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              in: "query",
              name: "ref",
              required: true,
              schema: { type: "string" },
              description: "Ingest job ref returned from upload_blob/recall_memories autoSave.saved[].ref",
            },
          ],
          responses: {
            "200": {
              description: "Current ingest status for the requested job ref.",
              content: {
                "application/json": {
                  schema: uploadIngestJobStatusSchema,
                },
              },
            },
            "404": { description: "Upload ingest job not found." },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/remember": {
        post: {
          operationId: "remember",
          summary: "Fallback direct save; prepare_response queues normal saves",
          description:
            "Fallback direct save for legacy GPTs or explicit save retries. Normal flow should call prepare_response first; it classifies facts/preferences/document notes and queues saves.",
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
            "402": {
              description: "Plan upgrade required for document sharing. Ask user to pay at billing_url; do not retry uploads.",
              content: {
                "application/json": {
                  schema: planRequiredErrorSchema,
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
            "402": {
              description: "Plan upgrade required for document sharing. Ask user to pay at billing_url.",
              content: {
                "application/json": {
                  schema: planRequiredErrorSchema,
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
          summary: "Fetch full text for a known @doc or @lot ref",
          description:
            "Use after recall_memories/recent_documents/search_documents returns a relevant ref and the answer needs full document text. Pass the exact @doc/@lot ref without inventing or guessing.",
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
              description: "Full document or lot text.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [documentRecallSchema, lotRecallSchema],
                  },
                },
              },
            },
            "404": { description: "Document or lot ref not found." },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
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

router.post("/actions/prepare_response", chatGptActionAuthMiddleware, requireScopes(["memory:read", "memory:write"]), async (req: AuthRequest, res: Response) => {
  const normalizedBody = normalizeUploadedFileRequestBody(req.body ?? {});
  try {
    const body = prepareResponseSchema.parse(normalizedBody);
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;

    const result = await executePrepareResponseAction(auth, {
      message: body.message,
      openaiFileIdRefs: body.openaiFileIdRefs,
      conversation_id: body.conversation_id ?? null,
      conversation_history: body.conversation_history,
      handoff_target: body.handoff_target ?? null,
      last_recall: body.last_recall ?? null,
      requesterIp: req.ip,
    });

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/prepare_response",
      ok: result.status < 400,
      error: result.status >= 400 ? "Failed to prepare response" : null,
    });

    res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json(zodValidationResponseBody(error, normalizedBody));
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
      return;
    }
    if (error instanceof DocumentSizeExceededError) {
      res.status(413).json({ error: error.message });
      return;
    }
    if (isTransientMemoryInfraError(error)) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/prepare_response",
        ok: false,
        error: error instanceof Error ? error.message : "Transient memory infra error",
      });
      const degraded = degradedRecallResponse();
      res.json({
        ...degraded,
        inlineDocuments: [],
        queuedSaves: [],
        replyInstructions: ["Memory infrastructure is temporarily degraded; answer from the current conversation only."],
        intent: {
          needsRecall: true,
          needsDocumentLookup: false,
          reusePreviousContext: false,
          contextDependent: true,
          saveCandidates: [],
        },
      });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/prepare_response",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to prepare response",
    });
    console.error("Error preparing ChatGPT response:", error);
    res.status(500).json({ error: "Failed to prepare response" });
  }
});

router.post("/actions/recall_memories", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  const normalizedBody = normalizeUploadedFileRequestBody(req.body ?? {});
  try {
    const body = recallSchema.parse(normalizedBody);
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const recallResult = await executeRecallAction(auth, {
      query: body.query,
      limit: body.limit,
      types: body.types,
      include_doc_refs: body.include_doc_refs,
      openaiFileIdRefs: body.openaiFileIdRefs,
      conversation_id: body.conversation_id ?? null,
      requesterIp: req.ip,
    });

    if (recallResult.status !== 200) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/recall_memories",
        ok: false,
        error: "One or more uploaded files failed to persist",
      });
      res.status(recallResult.status).json(recallResult.body);
      return;
    }

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/recall_memories",
      ok: true,
    });
    res.status(200).json(recallResult.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json(zodValidationResponseBody(error, normalizedBody));
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
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
  const normalizedBody = normalizeUploadedFileRequestBody(req.body ?? {});
  try {
    const body = rememberSchema.parse(normalizedBody);
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const rememberResult = await executeRememberAction(auth, body);
    if (rememberResult.status >= 400) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/remember",
        ok: false,
        error: typeof rememberResult.body["error"] === "string"
          ? String(rememberResult.body["error"])
          : "Failed to remember",
      });
      res.status(rememberResult.status).json(rememberResult.body);
      return;
    }

    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/remember", ok: true });
    res.status(rememberResult.status).json(rememberResult.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json(zodValidationResponseBody(error, normalizedBody));
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
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
  const normalizedBody = normalizeUploadedFileRequestBody(req.body ?? {});
  try {
    const body = uploadBlobBodySchema.parse(normalizedBody);
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const uploadResult = await executeUploadBlobAction(auth, body);
    if (uploadResult.status !== 200) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/upload_blob",
        ok: false,
        error: "One or more uploaded files failed to persist",
      });
      res.status(uploadResult.status).json(uploadResult.body);
      return;
    }

    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/upload_blob", ok: true });
    res.status(uploadResult.status).json(uploadResult.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json(zodValidationResponseBody(error, normalizedBody));
      return;
    }
    if (error instanceof UploadThingConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
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

router.get("/actions/upload_status", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = uploadStatusQuerySchema.parse(req.query ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const statusResult = await executeUploadStatusAction(auth, query.ref);
    if (statusResult.status === 404) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/upload_status",
        ok: false,
        error: "Upload ingest job not found",
      });
      res.status(404).json(statusResult.body);
      return;
    }

    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/upload_status", ok: true });
    res.status(statusResult.status).json(statusResult.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/upload_status",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to query upload status",
    });
    console.error("Error checking ChatGPT upload ingest status:", error);
    res.status(500).json({ error: "Failed to check upload status" });
  }
});

router.post("/actions/undo_save", chatGptActionAuthMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = undoSaveSchema.parse(req.body);
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const deleted = await executeUndoSaveAction(auth, body.ref);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/undo_save", ok: true });
    res.status(deleted.status).json(deleted.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const documents = await executeRecentDocumentsAction(auth, body.limit);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/recent_documents", ok: true });
    res.status(documents.status).json(documents.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const matches = await executeSearchDocumentsAction(auth, body.query, body.limit);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/search_documents", ok: true });
    res.status(matches.status).json(matches.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const document = await executeRecallDocumentAction(auth, body.ref);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/recall_document", ok: true });
    res.status(document.status).json(document.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json(planRequiredActionError(error));
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
