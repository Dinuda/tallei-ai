import { Router, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { AuthContext } from "../../../domain/auth/index.js";
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
import {
  enqueueUploadedFilesIngest,
  getUploadedFileIngestJobStatus,
  listRecentCompletedUploadedFileIngestJobs,
} from "../../../services/uploaded-file-ingest-jobs.js";
import { ingestUploadedFileToDocument } from "../../../services/uploaded-file-ingest.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import {
  authContextFromUserId,
  isJwtRevokedJti,
  peekLocalApiKeyValidation,
  validateApiKeyContext,
} from "../../../infrastructure/auth/auth.js";
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

const uploadStatusQuerySchema = z.object({
  ref: z.string().trim().min(1, "ref is required"),
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
    recentCompletedIngests: [],
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

function looksDocumentQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("@doc:")
    || normalized.includes("@lot:")
    || /\b(doc|document|pdf|report|brief|slide|deck|file|upload|attachment)\b/i.test(normalized)
  );
}

function shouldSearchMatchedDocuments(input: {
  query: string;
  includeDocRefs?: string[];
  openaiFileIdRefsCount: number;
}): boolean {
  if (input.openaiFileIdRefsCount > 0) return true;
  if ((input.includeDocRefs?.length ?? 0) > 0) return true;
  return looksDocumentQuery(input.query);
}

async function withSoftTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout?: () => void
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((resolve) => {
        timeoutHandle = setTimeout(() => {
          onTimeout?.();
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// TODO: move somwhere else, dont have data layer in route handler file
async function logChatGptAction(input: {
  auth: AuthRequest["authContext"];
  method:
    | "chatgpt/actions/recall_memories"
    | "chatgpt/actions/remember"
    | "chatgpt/actions/upload_blob"
    | "chatgpt/actions/upload_status"
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

const PLAN_CACHE_TTL_MS = 5 * 60_000;
const AUTH_CONTINUATION_HEADER = "X-Tallei-Auth-Continuation";
const AUTH_CONTINUATION_TTL_SECONDS = Math.max(60, config.authContinuationTtlSeconds);
const AUTH_CONTINUATION_ISSUER = "tallei-chatgpt-actions";
const AUTH_CONTINUATION_AUDIENCE = "chatgpt-actions";
const planCache = new Map<string, { plan: AuthContext["plan"]; exp: number }>();

function getCachedPlanSync(tenantId: string): AuthContext["plan"] | null {
  const cached = planCache.get(tenantId);
  if (!cached || cached.exp <= Date.now()) return null;
  return cached.plan;
}

async function cachedPlan(tenantId: string): Promise<AuthContext["plan"]> {
  const cached = getCachedPlanSync(tenantId);
  if (cached) return cached;
  const plan = await getPlanForTenant(tenantId);
  planCache.set(tenantId, { plan, exp: Date.now() + PLAN_CACHE_TTL_MS });
  return plan;
}

function toApiKeyContext(
  validation: { keyId: string; userId: string; tenantId: string; connectorType: string | null; plan: AuthContext["plan"] }
): AuthContext {
  return {
    userId: validation.userId,
    tenantId: validation.tenantId,
    authMode: "api_key",
    plan: validation.plan,
    keyId: validation.keyId,
    connectorType: validation.connectorType,
  };
}

type ContinuationPayload = {
  userId: string;
  tenantId: string;
  authMode: AuthContext["authMode"];
  plan: AuthContext["plan"];
  keyId?: string;
  connectorType?: string | null;
  clientId?: string;
  scopes?: string[];
};

function normalizePem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  return trimmed.replace(/\\n/g, "\n");
}

const AUTH_CONTINUATION_PRIVATE_KEY = normalizePem(config.authContinuationPrivateKey);
const AUTH_CONTINUATION_PUBLIC_KEY = normalizePem(config.authContinuationPublicKey);
const AUTH_CONTINUATION_USE_ES256 =
  AUTH_CONTINUATION_PRIVATE_KEY.length > 0 && AUTH_CONTINUATION_PUBLIC_KEY.length > 0;

function continuationSignKey(): jwt.Secret {
  if (AUTH_CONTINUATION_USE_ES256) return AUTH_CONTINUATION_PRIVATE_KEY;
  return config.apiKeyPepper || config.internalApiSecret;
}

function continuationVerifyKey(): jwt.Secret {
  if (AUTH_CONTINUATION_USE_ES256) return AUTH_CONTINUATION_PUBLIC_KEY;
  return config.apiKeyPepper || config.internalApiSecret;
}

function encodeAuthContinuation(auth: AuthContext): string {
  const payload: ContinuationPayload = {
    userId: auth.userId,
    tenantId: auth.tenantId,
    authMode: auth.authMode,
    plan: auth.plan,
    keyId: auth.keyId,
    connectorType: auth.connectorType ?? null,
    clientId: auth.clientId,
    scopes: auth.scopes ?? [],
  };
  return jwt.sign(payload, continuationSignKey(), {
    algorithm: AUTH_CONTINUATION_USE_ES256 ? "ES256" : "HS256",
    expiresIn: AUTH_CONTINUATION_TTL_SECONDS,
    issuer: AUTH_CONTINUATION_ISSUER,
    audience: AUTH_CONTINUATION_AUDIENCE,
    jwtid: randomUUID(),
  });
}

async function decodeAuthContinuation(raw: string): Promise<AuthContext | null> {
  const token = raw.trim();
  if (!token) return null;

  let parsed: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, continuationVerifyKey(), {
      algorithms: AUTH_CONTINUATION_USE_ES256 ? ["ES256"] : ["HS256"],
      issuer: AUTH_CONTINUATION_ISSUER,
      audience: AUTH_CONTINUATION_AUDIENCE,
    });
    if (!verified || typeof verified === "string") return null;
    parsed = verified;
  } catch {
    return null;
  }

  const jti = typeof parsed.jti === "string" ? parsed.jti : null;
  if (jti) {
    const revoked = await isJwtRevokedJti(jti);
    if (revoked) return null;
  }

  const userId = typeof parsed.userId === "string" ? parsed.userId : "";
  const tenantId = typeof parsed.tenantId === "string" ? parsed.tenantId : "";
  const authMode = typeof parsed.authMode === "string" ? parsed.authMode : "";
  const plan = typeof parsed.plan === "string" ? parsed.plan : "";
  if (!userId || !tenantId || !authMode || !plan) return null;

  return {
    userId,
    tenantId,
    authMode: authMode as AuthContext["authMode"],
    plan: plan as AuthContext["plan"],
    keyId: typeof parsed.keyId === "string" ? parsed.keyId : undefined,
    connectorType: typeof parsed.connectorType === "string" ? parsed.connectorType : null,
    clientId: typeof parsed.clientId === "string" ? parsed.clientId : undefined,
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
  };
}

function attachContinuationHeader(res: Response, auth: AuthContext): void {
  res.setHeader(AUTH_CONTINUATION_HEADER, encodeAuthContinuation(auth));
  setRequestTimingField("auth_continuation_issued", true);
  setRequestTimingField("auth_continuation_alg", AUTH_CONTINUATION_USE_ES256 ? "ES256" : "HS256");
}

async function resolveChatGptActionAuth(req: AuthRequest, res: Response): Promise<AuthContext | null> {
  if (req.authContext) return req.authContext;
  if (req.authModeHint === "api_key") {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      if (token) {
        const localValidation = peekLocalApiKeyValidation(token, req.ip);
        if (localValidation) {
          const localContext = toApiKeyContext(localValidation);
          if (localContext.connectorType && localContext.connectorType !== "chatgpt") {
            res.status(403).json({ error: "API key is not valid for ChatGPT actions" });
            return null;
          }
          req.userId = localContext.userId;
          req.authContext = localContext;
          attachContinuationHeader(res, localContext);
          setRequestTimingField("auth_deferred_wait_ms", 0);
          return localContext;
        }
      }
    }
  }
  if (!req.authPromise) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  try {
    const waitStartedAt = process.hrtime.bigint();
    const resolved = await req.authPromise;
    const waitedMs = Number(process.hrtime.bigint() - waitStartedAt) / 1_000_000;
    setRequestTimingField("auth_deferred_wait_ms", waitedMs);
    if (!resolved) {
      if (req.authFailure) {
        res.status(req.authFailure.status).json({ error: req.authFailure.error });
      } else {
        res.status(401).json({ error: "Unauthorized" });
      }
      return null;
    }
    req.userId = resolved.userId;
    req.authContext = resolved;
    attachContinuationHeader(res, resolved);
    return resolved;
  } catch (error) {
    console.error("ChatGPT deferred auth resolution failed:", error);
    res.status(500).json({ error: "Server error validating bearer token" });
    return null;
  }
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
    attachContinuationHeader(res, req.authContext);
    noteAuthTiming();
    next();
    return;
  }

  const continuationHeader = req.headers["x-tallei-auth-continuation"];
  if (typeof continuationHeader === "string" && continuationHeader.trim().length > 0) {
    const continued = await decodeAuthContinuation(continuationHeader);
    if (continued) {
      setRequestTimingField("auth_continuation_hit", true);
      req.userId = continued.userId;
      req.authContext = continued;
      noteAuthTiming();
      next();
      return;
    }
    setRequestTimingField("auth_continuation_hit", false);
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
    req.authModeHint = "api_key";
    const localValidation = peekLocalApiKeyValidation(token, req.ip);
    if (localValidation) {
      const localContext = toApiKeyContext(localValidation);
      if (localContext.connectorType && localContext.connectorType !== "chatgpt") {
        noteAuthTiming();
        res.status(403).json({ error: "API key is not valid for ChatGPT actions" });
        return;
      }
      req.userId = localContext.userId;
      req.authContext = localContext;
      attachContinuationHeader(res, localContext);
      noteAuthTiming();
      next();
      return;
    }

    req.authPromise = validateApiKeyContext(token, req.ip).then((validation) => {
      if (!validation) return null;
      const context = toApiKeyContext(validation);
      if (context.connectorType && context.connectorType !== "chatgpt") {
        req.authFailure = { status: 403, error: "API key is not valid for ChatGPT actions" };
        return null;
      }
      return context;
    }).catch((error) => {
      console.error("ChatGPT deferred API key auth failed:", error);
      req.authFailure = { status: 500, error: "Server error validating bearer token" };
      return null;
    });
    setRequestTimingField("auth_deferred", true);
    noteAuthTiming();
    next();
    return;
  }

  try {
    const tokenContext = await validateOAuthAccessToken(token);
    if (!tokenContext) {
      noteAuthTiming();
      res.status(401).json({ error: "Invalid bearer token" });
      return;
    }

    const plan = await cachedPlan(tokenContext.tenantId);
    req.userId = tokenContext.userId;
    req.authContext = {
      userId: tokenContext.userId,
      tenantId: tokenContext.tenantId,
      authMode: "oauth",
      plan,
      clientId: tokenContext.clientId,
      scopes: tokenContext.scopes,
    };
    attachContinuationHeader(res, req.authContext);
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
            "If files exist, call upload_blob to enqueue ingest, then poll upload_status as needed before relying on file content. " +
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
            "NON-NEGOTIABLE for file turns: call first to enqueue ingest. Supports PDF and Word (.docx/.docm). " +
            "Do not use direct attachment text before save. After enqueue, poll upload_status before claiming file content is available. " +
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
      "/api/chatgpt/actions/upload_status": {
        get: {
          operationId: "upload_status",
          summary: "Poll status for an async uploaded file ingest job",
          description:
            "Use this to check whether an upload_blob or recall_memories auto-save job has completed.",
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
          summary: "Unified save endpoint for memory and documents (supports uploaded files)",
          description:
            "Use for explicit saves and cadence: every 5 user messages, save a concise fact summary unless user opts out. " +
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const uploadedFiles = body.openaiFileIdRefs ?? [];
    const matchedDocsEnabled = shouldSearchMatchedDocuments({
      query: body.query,
      includeDocRefs: body.include_doc_refs,
      openaiFileIdRefsCount: uploadedFiles.length,
    });
    setRequestTimingField("recall_matched_docs_enabled", matchedDocsEnabled);

    const matchedDocumentsPromise = matchedDocsEnabled
      ? (async () => {
        const startedAt = process.hrtime.bigint();
        const matched = await withSoftTimeout(
          searchDocuments(body.query, auth, 3).catch(() => []),
          600,
          [],
          () => setRequestTimingField("recall_matched_docs_timeout", true)
        );
        setRequestTimingField(
          "recall_matched_docs_ms",
          Number(process.hrtime.bigint() - startedAt) / 1_000_000
        );
        return matched;
      })()
      : Promise.resolve([]);

    const recentDocsPromise = (async () => {
      const startedAt = process.hrtime.bigint();
      const docs = await recentDocumentBriefs(auth, 5);
      setRequestTimingField(
        "recall_recent_docs_ms",
        Number(process.hrtime.bigint() - startedAt) / 1_000_000
      );
      return docs;
    })();

    const recentIngestsEnabled = Boolean(body.conversation_id) || uploadedFiles.length > 0;
    setRequestTimingField("recall_recent_ingests_enabled", recentIngestsEnabled);
    const recentIngestsPromise = recentIngestsEnabled
      ? (async () => {
        const startedAt = process.hrtime.bigint();
        const ingests = await listRecentCompletedUploadedFileIngestJobs(auth, {
          conversation_id: body.conversation_id ?? null,
          limit: 5,
        });
        setRequestTimingField(
          "recall_recent_ingests_ms",
          Number(process.hrtime.bigint() - startedAt) / 1_000_000
        );
        return ingests;
      })()
      : Promise.resolve([]);

    const [result, recentDocuments, matchedDocuments, recentCompletedIngests] = await Promise.all([
      recallMemories(body.query, auth, body.limit, req.ip, {
        types: recallTypesOrDefault(body.types),
      }),
      recentDocsPromise,
      matchedDocumentsPromise,
      recentIngestsPromise,
    ]);
    const refs = [...new Set((body.include_doc_refs ?? []).map((value) => value.trim()).filter(Boolean))];
    const referencedDocuments = refs.length > 0
      ? await (async () => {
        const startedAt = process.hrtime.bigint();
        const result = await documentBriefsByRefs(refs, auth, { maxLotDocs: 5 });
        setRequestTimingField(
          "recall_referenced_docs_ms",
          Number(process.hrtime.bigint() - startedAt) / 1_000_000
        );
        return result;
      })()
      : [];

    const autoSaved: Array<{
      ref: string;
      status: "pending";
      filename: string;
      conversation_id: string | null;
    }> = [];
    const autoSaveErrors: Array<{ file_id: string; filename: string; error: string }> = [];
    if (uploadedFiles.length > 0) {
      assertUploadThingConfigured();
      const { enqueued, errors } = await enqueueUploadedFilesIngest(uploadedFiles, auth, {
        conversation_id: body.conversation_id ?? null,
      });
      autoSaved.push(...enqueued);
      autoSaveErrors.push(...errors);
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
      recentCompletedIngests,
      autoSave: {
        requested: uploadedFiles.length,
        complete: autoSaveErrors.length === 0,
        saved: autoSaved,
        errors: autoSaveErrors,
      },
      ...(autoSaved.length > 0 ? {
        autoSaved,
        autoSaveNotice: `Queued ${autoSaved.length} file(s) for background ingest. Use upload_status with returned ref values to check completion.`,
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
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
            }, auth, { conversationId: body.conversation_id ?? null });
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
          const blobSaved = await ingestUploadedFileToDocument(fileRef, auth, {
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
      const saved = await saveMemory(body.content, auth, body.platform ?? "chatgpt", req.ip);
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
      const saved = await savePreference(body.content, auth, body.platform ?? "chatgpt", req.ip, {
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
      }, auth, { conversationId: body.conversation_id ?? null });
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
    const saved = await stashDocument(body.content, auth, { title: body.title ?? undefined });
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    assertUploadThingConfigured();

    const { enqueued, errors } = await enqueueUploadedFilesIngest(body.openaiFileIdRefs, auth, {
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
        count_saved: enqueued.length,
        count_failed: errors.length,
        saved: enqueued,
        errors,
      });
      return;
    }

    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/upload_blob", ok: true });
    res.json({
      success: true,
      count_saved: enqueued.length,
      count_failed: 0,
      saved: enqueued,
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

router.get("/actions/upload_status", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = uploadStatusQuerySchema.parse(req.query ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const status = await getUploadedFileIngestJobStatus(auth, query.ref);
    if (!status) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/upload_status",
        ok: false,
        error: "Upload ingest job not found",
      });
      res.status(404).json({ error: "Upload ingest job not found" });
      return;
    }

    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/upload_status", ok: true });
    res.json(status);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
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
    const deleted = await deleteDocumentByRef(body.ref, auth);
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const documents = await recentDocumentBriefs(auth, body.limit);
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const matches = await searchDocuments(body.query, auth, body.limit);
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
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const document = await recallDocument(body.ref, auth);
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
