import { Router, Response, NextFunction } from "express";
import { createPrivateKey, createPublicKey, randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { AuthContext } from "../../../domain/auth/index.js";
import { AuthRequest, requireScopes, safeSecretEqual } from "../middleware/auth.middleware.js";
import { config } from "../../../config/index.js";
import { CHATGPT_OPENAPI_VERSION } from "../../shared/integration-assets.js";
import { UploadThingConfigError } from "../../../infrastructure/storage/uploadthing-client.js";
import { DocumentSizeExceededError } from "../../../services/documents.js";
import {
  buildFirstTurnContinueCommand,
  buildTurnFallbackContext,
  claimTurn,
  CollabConflictError,
  CollabNotFoundError,
  createTask as createCollabTask,
  getTask,
  hydrateTaskWithRecentPreparedUploads,
  inlineDocumentsFromTaskContext,
  listTasks,
  submitTurn,
} from "../../../services/collab.js";
import {
  abortSession as abortOrchestrationSession,
  approvePlan as approveOrchestrationPlan,
  buildSessionFallbackContext,
  OrchestrationConflictError,
  OrchestrationInvalidPlanError,
  OrchestrationNotFoundError,
  startSession as startOrchestrationSession,
  submitAnswer as submitOrchestrationAnswer,
} from "../../../services/orchestrator.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import {
  authContextFromUserId,
  isJwtRevokedJti,
  peekLocalApiKeyValidation,
  validateApiKeyContext,
} from "../../../infrastructure/auth/auth.js";
import { getPlanForTenant } from "../../../infrastructure/auth/tenancy.js";
import { hasRequiredScopes, validateOAuthAccessToken } from "../../../infrastructure/auth/oauth-tokens.js";
import { setRequestTimingField } from "../../../observability/request-timing.js";
import { runAsyncSafe } from "../../../shared/async-safe.js";
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

const router = Router();
const memoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note", "lesson", "failure"]);
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

const collabTaskIdSchema = z.object({
  task_id: z.string().uuid("task_id must be a valid UUID"),
});

const collabCreateTaskSchema = z.object({
  title: z.string().trim().min(1, "title is required"),
  brief: z.string().optional(),
  first_actor: z.enum(["chatgpt", "claude"]).optional().default("chatgpt"),
  max_iterations: z.coerce.number().int().min(1).max(8).optional(),
});

const collabSubmitTurnSchema = z.object({
  task_id: z.string().uuid("task_id must be a valid UUID"),
  content: z.string().trim().min(1, "content is required"),
  mark_done: z.boolean().optional().default(false),
});

const collabContinueSchema = z.object({
  message: z.string().trim().min(1, "message is required"),
  task_id: z.string().uuid("task_id must be a valid UUID").optional(),
  draft_output: z.string().trim().optional(),
  mark_done: z.boolean().optional().default(false),
});

const orchestrateStartSchema = z.object({
  goal: z.string().trim().min(1, "goal is required"),
  first_actor_preference: z.enum(["chatgpt", "claude"]).optional(),
  initial_context: z.string().optional(),
});

const orchestrateAnswerSchema = z.object({
  session_id: z.string().uuid("session_id must be a valid UUID"),
  answer: z.string().trim().min(1, "answer is required"),
});

const orchestrateApproveSchema = z.object({
  session_id: z.string().uuid("session_id must be a valid UUID"),
  overrides: z.object({
    first_actor: z.enum(["chatgpt", "claude"]).optional(),
    max_iterations: z.coerce.number().int().min(1).max(8).optional(),
  }).optional(),
});

const orchestrateAbortSchema = z.object({
  session_id: z.string().uuid("session_id must be a valid UUID"),
  reason: z.string().optional(),
});

type EventMetadata = Record<string, unknown>;

// TODO: move somwhere else, dont have data layer in route handler file
async function logChatGptAction(input: {
  auth: AuthRequest["authContext"];
  method:
    | "chatgpt/actions/recall_memories"
    | "chatgpt/actions/prepare_response"
    | "chatgpt/actions/remember"
    | "chatgpt/actions/upload_blob"
    | "chatgpt/actions/upload_status"
    | "chatgpt/actions/undo_save"
    | "chatgpt/actions/recent_documents"
    | "chatgpt/actions/search_documents"
    | "chatgpt/actions/recall_document"
    | "chatgpt/collab/create-task"
    | "chatgpt/collab/run-turn"
    | "chatgpt/collab/submit-turn"
    | "chatgpt/collab/continue"
    | "chatgpt/collab/tasks"
    | "chatgpt/actions/orchestrate_start"
    | "chatgpt/actions/orchestrate_answer"
    | "chatgpt/actions/orchestrate_approve"
    | "chatgpt/actions/orchestrate_abort";
  collabTaskId?: string | null;
  metadata?: EventMetadata | null;
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  const auth = input.auth;
  if (!auth) return;

  // TODO: see if you can multi-thread this or something if the db insert becomes a bottleneck. Dont want to lose events but also dont want to slow down the main request flow. Also will 
  // probably want to batch these up and do bulk inserts if traffic is high, expect 100k events/month at 10k users and 1-2 events per user per day.
  try {
    await pool.query(
      `INSERT INTO mcp_call_events (
        tenant_id, user_id, key_id, auth_mode, method, tool_name, collab_task_id, metadata_json, ok, error
      )
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::jsonb, $8, $9)`,
      [
        auth.tenantId,
        auth.userId,
        auth.keyId ?? null,
        auth.authMode,
        input.method,
        input.collabTaskId ?? null,
        JSON.stringify(input.metadata ?? {}),
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

function readBodyTaskId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)["task_id"];
  return typeof value === "string" ? value : null;
}

function previewText(value: string, max = 500): string {
  return value.trim().slice(0, max);
}

function appendContinueCommand(
  userVisible: string,
  command: ReturnType<typeof buildFirstTurnContinueCommand>
): string {
  if (!command) return userVisible;
  return `${userVisible}\n\n${command.instruction}`;
}

function postgresErrorDetails(error: unknown): {
  code: string;
  constraint: string | null;
  message: string;
} | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return null;
  const constraint = (error as { constraint?: unknown }).constraint;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "Database error");
  return {
    code,
    constraint: typeof constraint === "string" ? constraint : null,
    message,
  };
}

function hasLocalSandboxDownloadLink(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  const refs = record["openaiFileIdRefs"];
  if (!Array.isArray(refs)) return false;
  return refs.some((item) => {
    if (!item || typeof item !== "object") return false;
    const link = (item as Record<string, unknown>)["download_link"];
    if (typeof link !== "string") return false;
    const normalized = link.trim().toLowerCase();
    return normalized.startsWith("/mnt/data/") || normalized.startsWith("file://");
  });
}

function zodValidationResponseBody(error: z.ZodError, normalizedBody: unknown): Record<string, unknown> {
  if (!hasLocalSandboxDownloadLink(normalizedBody)) {
    return { error: "Validation failed", details: error.errors };
  }
  return {
    error: "Invalid file download links in openaiFileIdRefs",
    code: "invalid_download_link",
    user_message:
      "File refs must include presigned HTTPS download links from GPT Actions (for example files.oaiusercontent.com). Local sandbox paths like /mnt/data/... or file://... are not supported. Re-send the action call with valid openaiFileIdRefs.",
    details: error.errors,
  };
}

const UUID_V4_LIKE_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function extractTaskIdFromText(message: string): string | null {
  const match = message.match(UUID_V4_LIKE_REGEX)?.[0] ?? null;
  if (!match) return null;
  const parsed = z.string().uuid().safeParse(match);
  return parsed.success ? parsed.data : null;
}

function isCollabContinuePrompt(message: string): boolean {
  const hasTaskId = Boolean(extractTaskIdFromText(message));
  if (!hasTaskId) return false;
  return /\bcollab\b|\bcontinue\b|\bresume\b|\btask\b|\bproceed\b/i.test(message);
}

const COLLAB_STAGE_REGEX = /^\[COLLAB:(CREATE|CONTINUE|MY_TURN)(?::([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))?\]/i;

function extractCollabStage(message: string): {
  stage: "CREATE" | "CONTINUE" | "MY_TURN";
  taskId: string | null;
} | null {
  const m = message.match(COLLAB_STAGE_REGEX);
  if (!m) return null;
  const stage = m[1].toUpperCase() as "CREATE" | "CONTINUE" | "MY_TURN";
  const rawId = m[2] ?? null;
  const taskId = rawId ? (z.string().uuid().safeParse(rawId).success ? rawId : null) : null;
  return { stage, taskId };
}

function collabStageReplyInstructions(stage: "CREATE" | "CONTINUE" | "MY_TURN", taskId: string | null): string[] {
  const taskLabel = taskId ? ` (task ${taskId})` : "";
  if (stage === "CREATE") {
    return [
      "Memory recall and document save complete. Do not call prepare_response again for this turn.",
      "Call createCollabTask with the user-provided args (title, brief, first_actor — default 'chatgpt', max_iterations). Do not pass file or document args.",
      "Immediately after createCollabTask succeeds, call collab_continue with the original user message and draft_output if ready.",
      "Show the actual submitted output after collab_continue succeeds.",
      "If any collab action returns continue_command, end the user-facing response with its instruction.",
      "Do not create a Claude handoff prompt; ask whether to hand off now and use only the returned continue_command.",
    ];
  }
  if (stage === "CONTINUE") {
    return [
      "Document save complete. Do not call prepare_response again for this turn.",
      `Call collab_continue with the exact user message${taskLabel}. Do not pass file or document args.`,
      "If is_my_turn=true, include draft_output in the same collab_continue call.",
      "If is_my_turn=false, report which actor (next_actor) is expected and stop.",
      "Show the actual submitted output after a successful submit.",
      "If any collab action returns continue_command, end the user-facing response with its instruction.",
      "Do not create a Claude handoff prompt; ask whether to hand off now and use only the returned continue_command.",
    ];
  }
  return [
    "Document save complete. Do not call prepare_response again for this turn.",
    `Call collab_continue with the exact user message and draft_output included${taskLabel}. Do not pass file or document args.`,
    "Show the actual submitted output after collab_continue succeeds.",
    "If any collab action returns continue_command, end the user-facing response with its instruction.",
    "Do not create a Claude handoff prompt; ask whether to hand off now and use only the returned continue_command.",
    "If the call fails, return the exact error and stop.",
  ];
}

const PLAN_CACHE_TTL_MS = 5 * 60_000;
const AUTH_CONTINUATION_HEADER = "X-Tallei-Auth-Continuation";
const AUTH_CONTINUATION_TTL_SECONDS = Math.max(60, config.authContinuationTtlSeconds);
const AUTH_CONTINUATION_ISSUER = "tallei-chatgpt-actions";
const AUTH_CONTINUATION_AUDIENCE = "chatgpt-actions";
const DOCUMENT_SHARING_BILLING_URL = `${config.dashboardBaseUrl.replace(/\/$/, "")}/billing`;
const planCache = new Map<string, { plan: AuthContext["plan"]; exp: number }>();

type PlanRequiredActionErrorBody = {
  error: string;
  code: "plan_required";
  feature: "document_sharing";
  billing_url: string;
  user_message: string;
};

function planRequiredActionError(error: PlanRequiredError): PlanRequiredActionErrorBody {
  return {
    error: error.message,
    code: "plan_required",
    feature: "document_sharing",
    billing_url: DOCUMENT_SHARING_BILLING_URL,
    user_message: `Document sharing is a Pro feature on Tallei. Please complete payment at ${DOCUMENT_SHARING_BILLING_URL} to continue.`,
  };
}

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
  const unquoted =
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unquoted.replace(/\\n/g, "\n");
}

type ContinuationSigningConfig = {
  useEs256: boolean;
  signKey: jwt.Secret | Parameters<typeof createPrivateKey>[0];
  verifyKey: jwt.Secret | Parameters<typeof createPublicKey>[0];
};

function resolveContinuationSigningConfig(): ContinuationSigningConfig {
  const fallbackSecret = config.apiKeyPepper || config.internalApiSecret;
  const privatePem = normalizePem(config.authContinuationPrivateKey);
  const publicPem = normalizePem(config.authContinuationPublicKey);

  if (!privatePem || !publicPem) {
    return {
      useEs256: false,
      signKey: fallbackSecret,
      verifyKey: fallbackSecret,
    };
  }

  try {
    const privateKey = createPrivateKey(privatePem);
    const publicKey = createPublicKey(publicPem);

    if (privateKey.type !== "private" || publicKey.type !== "public") {
      throw new Error("continuation key pair must include private/public asymmetric keys");
    }

    if (privateKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyType !== "ec") {
      throw new Error("continuation key pair must be EC keys for ES256");
    }

    return {
      useEs256: true,
      signKey: privateKey,
      verifyKey: publicKey,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[chatgpt] invalid auth continuation ES256 key configuration; falling back to HS256 (${reason})`
    );
    return {
      useEs256: false,
      signKey: fallbackSecret,
      verifyKey: fallbackSecret,
    };
  }
}

const CONTINUATION_SIGNING = resolveContinuationSigningConfig();
const AUTH_CONTINUATION_USE_ES256 = CONTINUATION_SIGNING.useEs256;

function continuationSignKey(): jwt.Secret {
  return CONTINUATION_SIGNING.signKey as jwt.Secret;
}

function continuationVerifyKey(): jwt.Secret {
  return CONTINUATION_SIGNING.verifyKey as jwt.Secret;
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
  try {
    res.setHeader(AUTH_CONTINUATION_HEADER, encodeAuthContinuation(auth));
    setRequestTimingField("auth_continuation_issued", true);
    setRequestTimingField("auth_continuation_alg", AUTH_CONTINUATION_USE_ES256 ? "ES256" : "HS256");
  } catch (error) {
    setRequestTimingField("auth_continuation_issued", false);
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[chatgpt] failed to issue auth continuation token (${reason})`);
  }
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
      feature: { type: "string", enum: ["document_sharing"] },
      billing_url: { type: "string", format: "uri" },
      user_message: { type: "string" },
    },
  };

  const collabTranscriptEntrySchema = {
    type: "object",
    required: ["actor", "iteration", "content", "ts"],
    properties: {
      actor: { type: "string", enum: ["chatgpt", "claude", "user"] },
      iteration: { type: "integer" },
      content: { type: "string" },
      ts: { type: "string", format: "date-time" },
    },
  };

  const collabTaskSchema = {
    type: "object",
    required: [
      "id",
      "tenantId",
      "userId",
      "title",
      "state",
      "iteration",
      "maxIterations",
      "context",
      "transcript",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      tenantId: { type: "string", format: "uuid" },
      userId: { type: "string", format: "uuid" },
      title: { type: "string" },
      brief: { type: ["string", "null"] },
      state: { type: "string", enum: ["CREATIVE", "TECHNICAL", "DONE", "ERROR"] },
      lastActor: { type: ["string", "null"], enum: ["chatgpt", "claude", "user", null] },
      iteration: { type: "integer" },
      maxIterations: { type: "integer" },
      context: { type: "object", additionalProperties: true },
      transcript: { type: "array", items: collabTranscriptEntrySchema },
      errorMessage: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  };

  const collabContinueCommandSchema = {
    oneOf: [
      {
        type: "object",
        required: ["target_actor", "command", "label", "instruction"],
        properties: {
          target_actor: { type: "string", enum: ["chatgpt", "claude"] },
          command: { type: "string" },
          label: { type: "string" },
          instruction: { type: "string" },
        },
      },
      { type: "null" },
    ],
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Tallei ChatGPT Actions API",
      version: CHATGPT_OPENAPI_VERSION,
      description:
        "Docs-lite shared-memory Actions API for ChatGPT Custom GPTs (Bearer API key). " +
        "Call prepare_response on every turn; include openaiFileIdRefs with temporary HTTPS file URLs when attachments are visible. " +
        "For collab flows, prefix the message with [COLLAB:CREATE], [COLLAB:CONTINUE:<uuid>], or [COLLAB:MY_TURN:<uuid>] — the action returns stage-specific replyInstructions telling you exactly which collab action to call next.",
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
          summary: "PRIMARY ACTION: prepare context, queue saves, and route collab stages",
          description:
            "Call every turn. Include openaiFileIdRefs with temporary HTTPS download_link URLs for visible attachments; use [] only when none are visible. For collab, this uploads docs before replyInstructions route the next action.",
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
      "/api/chatgpt/actions/orchestrate_start": {
        post: {
          operationId: "orchestrate_start",
          summary: "Start orchestration planning session",
          description: "Starts role selection plus grill-me planning before collab task creation.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["goal"],
                  properties: {
                    goal: { type: "string" },
                    first_actor_preference: { type: "string", enum: ["chatgpt", "claude"] },
                    initial_context: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Session started with role_suggestion, question_payload, and next_instruction.",
            },
            "400": { description: "Validation failed" },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/orchestrate_answer": {
        post: {
          operationId: "orchestrate_answer",
          summary: "Continue orchestration planning session",
          description: "Submits an answer and returns next question or plan when ready.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["session_id", "answer"],
                  properties: {
                    session_id: { type: "string", format: "uuid" },
                    answer: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Session advanced." },
            "400": { description: "Validation failed" },
            "404": { description: "Session not found" },
            "409": { description: "Session conflict" },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/orchestrate_approve": {
        post: {
          operationId: "orchestrate_approve",
          summary: "Approve orchestration plan and create collab task",
          description: "Approves a PLAN_READY session and starts the linked collab task.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["session_id"],
                  properties: {
                    session_id: { type: "string", format: "uuid" },
                    overrides: {
                      type: "object",
                      properties: {
                        first_actor: { type: "string", enum: ["chatgpt", "claude"] },
                        max_iterations: { type: "integer", minimum: 1, maximum: 8 },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Plan approved." },
            "400": { description: "Validation failed" },
            "404": { description: "Session not found" },
            "409": { description: "Session conflict" },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/orchestrate_abort": {
        post: {
          operationId: "orchestrate_abort",
          summary: "Abort orchestration session",
          description: "Aborts an active orchestration session.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["session_id"],
                  properties: {
                    session_id: { type: "string", format: "uuid" },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Session aborted." },
            "400": { description: "Validation failed" },
            "404": { description: "Session not found" },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/collab/tasks": {
        get: {
          operationId: "listCollabTasks",
          summary: "List collab tasks for ChatGPT",
          description: "Lists collab tasks visible to the authenticated user.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Collab task list.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["tasks"],
                    properties: {
                      tasks: {
                        type: "array",
                        items: collabTaskSchema,
                      },
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
      "/api/chatgpt/actions/collab_continue": {
        post: {
          operationId: "collab_continue",
          summary: "Collab continue — second step after prepare_response in collab flows",
          description:
            "Second step after prepare_response for all collab flows (CREATE, CONTINUE, MY_TURN). " +
            "Provide message and optionally draft_output. " +
            "If it's your turn and draft_output is present, this call submits the turn. " +
            "If is_my_turn=false, report next_actor to the user and stop.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  properties: {
                    message: { type: "string" },
                    task_id: { type: "string", format: "uuid" },
                    draft_output: { type: "string" },
                    mark_done: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Collab turn check or submit result.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "is_my_turn", "task_id", "state", "iteration", "max_iterations", "next_actor", "user_visible"],
                    properties: {
                      ok: { type: "boolean" },
                      is_my_turn: { type: "boolean" },
                      task_id: { type: "string", format: "uuid" },
                      state: { type: "string", enum: ["CREATIVE", "TECHNICAL", "DONE", "ERROR"] },
                      iteration: { type: "integer" },
                      max_iterations: { type: "integer" },
                      next_actor: { type: ["string", "null"], enum: ["chatgpt", "claude", null] },
                      user_visible: { type: "string" },
                      continue_command: collabContinueCommandSchema,
                      submitted: { type: "boolean" },
                      last_message: {
                        oneOf: [collabTranscriptEntrySchema, { type: "null" }],
                      },
                      recent_transcript: {
                        type: "array",
                        items: collabTranscriptEntrySchema,
                      },
                      saved_turn: {
                        oneOf: [
                          {
                            type: "object",
                            required: ["actor", "iteration", "ts", "content", "content_length", "content_preview"],
                            properties: {
                              actor: { type: "string", enum: ["chatgpt", "claude", "user"] },
                              iteration: { type: "integer" },
                              ts: { type: "string", format: "date-time" },
                              content: { type: "string" },
                              content_length: { type: "integer" },
                              content_preview: { type: "string" },
                            },
                          },
                          { type: "null" },
                        ],
                      },
                      fallback_context: { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
            "400": { description: "Validation failed" },
            "404": { description: "Task not found" },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/collab/create-task": {
        post: {
          operationId: "createCollabTask",
          summary: "Create a collab task",
          description: "Creates a new collab task that can be continued via run-turn/submit-turn.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    brief: { type: "string" },
                    first_actor: { type: "string", enum: ["chatgpt", "claude"], default: "chatgpt" },
                    max_iterations: { type: "integer", minimum: 1, maximum: 8 },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Task created.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "task_id", "title", "state", "iteration", "max_iterations", "user_visible"],
                    properties: {
                      ok: { type: "boolean" },
                      task_id: { type: "string", format: "uuid" },
                      title: { type: "string" },
                      brief: { type: ["string", "null"] },
                      state: { type: "string", enum: ["CREATIVE", "TECHNICAL", "DONE", "ERROR"] },
                      iteration: { type: "integer" },
                      max_iterations: { type: "integer" },
                      user_visible: { type: "string" },
                      continue_command: collabContinueCommandSchema,
                    },
                  },
                },
              },
            },
            "400": { description: "Validation failed" },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/collab/run-turn": {
        post: {
          operationId: "runCollabTurn",
          summary: "Check whether it is ChatGPT's turn",
          description: "Checks the current collab task state for ChatGPT without allowing actor override. Call at most once per user turn before deciding whether to submit output.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["task_id"],
                  properties: {
                    task_id: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Turn status payload.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["is_my_turn", "task_id", "state", "iteration", "max_iterations", "next_actor", "user_visible", "context"],
                    properties: {
                      is_my_turn: { type: "boolean" },
                      task_id: { type: "string", format: "uuid" },
                      state: { type: "string", enum: ["CREATIVE", "TECHNICAL", "DONE", "ERROR"] },
                      iteration: { type: "integer" },
                      max_iterations: { type: "integer" },
                      next_actor: { type: ["string", "null"], enum: ["chatgpt", "claude", null] },
                      user_visible: { type: "string" },
                      continue_command: collabContinueCommandSchema,
                      last_message: {
                        oneOf: [
                          collabTranscriptEntrySchema,
                          { type: "null" },
                        ],
                      },
                      context: { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
            "404": { description: "Task not found" },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/collab/submit-turn": {
        post: {
          operationId: "submitCollabTurn",
          summary: "Submit ChatGPT turn content",
          description: "Submits ChatGPT output for a collab task without allowing actor override. After success, render saved_turn.content in chat and stop tool-calling for this user turn.",
          "x-openai-isConsequential": false,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["task_id", "content"],
                  properties: {
                    task_id: { type: "string", format: "uuid" },
                    content: { type: "string" },
                    mark_done: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Turn saved with compact user-visible summary.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "task_id", "state", "iteration", "max_iterations", "user_visible", "saved_turn"],
                    properties: {
                      ok: { type: "boolean" },
                      task_id: { type: "string", format: "uuid" },
                      state: { type: "string", enum: ["CREATIVE", "TECHNICAL", "DONE", "ERROR"] },
                      iteration: { type: "integer" },
                      max_iterations: { type: "integer" },
                      next_actor: { type: ["string", "null"], enum: ["chatgpt", "claude", null] },
                      user_visible: { type: "string" },
                      continue_command: collabContinueCommandSchema,
                      saved_turn: {
                        oneOf: [
                          {
                            type: "object",
                            required: ["actor", "iteration", "ts", "content", "content_length", "content_preview"],
                            properties: {
                              actor: { type: "string", enum: ["chatgpt", "claude", "user"] },
                              iteration: { type: "integer" },
                              ts: { type: "string", format: "date-time" },
                              content: { type: "string" },
                              content_length: { type: "integer" },
                              content_preview: { type: "string" },
                            },
                          },
                          { type: "null" },
                        ],
                      },
                    },
                  },
                },
              },
            },
            "404": { description: "Task not found" },
            "409": { description: "Turn conflict" },
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

    const collabStage = extractCollabStage(body.message);
    const hasAttachments = (body.openaiFileIdRefs?.length ?? 0) > 0;

    // CONTINUE and MY_TURN without attachments: skip memory flow, return routing instructions only
    if (collabStage && collabStage.stage !== "CREATE" && !hasAttachments) {
      const { stage, taskId } = collabStage;
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/prepare_response",
        collabTaskId: taskId,
        metadata: { category: "collab", action: "prepare_short_circuit", stage, task_id_detected: taskId },
        ok: true,
      });
      res.json({
        contextBlock: `Collab stage [${stage}]${taskId ? ` (task ${taskId})` : ""} detected. Memory flow skipped.`,
        memories: [],
        recentDocuments: [],
        matchedDocuments: [],
        referencedDocuments: [],
        recentCompletedIngests: [],
        inlineDocuments: [],
        queuedSaves: [],
        autoSave: { requested: 0, complete: true, saved: [], errors: [] },
        replyInstructions: collabStageReplyInstructions(stage, taskId),
        intent: {
          needsRecall: false,
          needsDocumentLookup: false,
          reusePreviousContext: false,
          contextDependent: false,
          saveCandidates: [],
        },
      });
      return;
    }

    // Legacy fallback: untagged collab continue prompts (UUID + collab keyword)
    if (isCollabContinuePrompt(body.message)) {
      const detectedTaskId = extractTaskIdFromText(body.message);
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/prepare_response",
        collabTaskId: detectedTaskId,
        metadata: { category: "collab", action: "prepare_short_circuit", task_id_detected: detectedTaskId },
        ok: true,
      });
      res.json({
        contextBlock: `Collab task prompt detected${detectedTaskId ? ` for ${detectedTaskId}` : ""}. Skip memory flow and call collab_continue now.`,
        memories: [],
        recentDocuments: [],
        matchedDocuments: [],
        referencedDocuments: [],
        recentCompletedIngests: [],
        inlineDocuments: [],
        queuedSaves: [],
        autoSave: { requested: 0, complete: true, saved: [], errors: [] },
        replyInstructions: [
          "Do not call prepare_response again for this turn.",
          "Call collab_continue now with this same message.",
          "After successful submit, render saved_turn.content in chat.",
        ],
        intent: {
          needsRecall: false,
          needsDocumentLookup: false,
          reusePreviousContext: false,
          contextDependent: false,
          saveCandidates: [],
        },
      });
      return;
    }

    // For CREATE: strip the tag so the classifier sees the real message and runs recall normally.
    // For CONTINUE/MY_TURN with attachments: keep the tag so the classifier returns needsRecall=false
    // (skips vector search) but still runs file ingest.
    const recallMessage = collabStage?.stage === "CREATE"
      ? body.message.replace(COLLAB_STAGE_REGEX, "").trim()
      : body.message;

    const result = await executePrepareResponseAction(auth, {
      message: recallMessage,
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

    // For any collab stage: override replyInstructions with stage-specific routing
    if (collabStage && result.status < 400 && result.body && typeof result.body === "object") {
      const stageInstructions = collabStageReplyInstructions(collabStage.stage, collabStage.taskId);
      const fileRefHint = !hasAttachments
        ? [
          "If this turn has visible attachments, file refs are missing. Ask for temporary HTTPS download URLs for those attachments (openaiFileIdRefs), then call prepare_response again with those refs before continuing collab.",
        ]
        : [];
      (result.body as Record<string, unknown>).replyInstructions = [...fileRefHint, ...stageInstructions];
    }

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
    const document = await executeRecallDocumentAction(auth, body.ref);
    logChatGptActionAsync({ auth: req.authContext, method: "chatgpt/actions/recall_document", ok: true });
    res.status(document.status).json(document.body);
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

router.post("/actions/orchestrate_start", chatGptActionAuthMiddleware, requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = orchestrateStartSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;

    const result = await startOrchestrationSession(
      {
        goal: body.goal,
        sourcePlatform: "chatgpt",
        firstActorPreference: body.first_actor_preference,
        initialContext: body.initial_context ?? null,
      },
      auth
    );

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_start",
      metadata: {
        category: "orchestration",
        action: "start",
        session_id: result.session.id,
      },
      ok: true,
    });

    res.json({
      session_id: result.session.id,
      status: result.session.status,
      question: result.firstQuestion,
      question_payload: result.firstQuestionData ?? { question: result.firstQuestion },
      role_suggestion: result.roleSelection,
      next_instruction: "Review the roles and answer the grill-me question, or say continue to accept the recommended/default answer.",
      fallback_context: buildSessionFallbackContext(result.session),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_start",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to start orchestration session",
    });
    res.status(500).json({ error: "Failed to start orchestration session" });
  }
});

router.post("/actions/orchestrate_answer", chatGptActionAuthMiddleware, requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = orchestrateAnswerSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const result = await submitOrchestrationAnswer(body.session_id, body.answer, auth);

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_answer",
      metadata: {
        category: "orchestration",
        action: "answer",
        session_id: body.session_id,
        status: result.session.status,
      },
      ok: true,
    });

    res.json({
      session_id: result.session.id,
      status: result.session.status,
      question: result.nextQuestion ?? null,
      question_payload: result.nextQuestionData ?? (result.nextQuestion ? { question: result.nextQuestion } : null),
      plan: result.plan ?? result.session.plan,
      next_instruction: result.planReady
        ? "Review the plan. If it looks good, say continue so orchestrate_approve can create the collab task."
        : "Review and answer the next grill-me question, or say continue to accept the recommended/default answer.",
      fallback_context: buildSessionFallbackContext(result.session),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof OrchestrationConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_answer",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to continue orchestration session",
    });
    res.status(500).json({ error: "Failed to continue orchestration session" });
  }
});

router.post("/actions/orchestrate_approve", chatGptActionAuthMiddleware, requireScopes(["orchestrate:write", "collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = orchestrateApproveSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const result = await approveOrchestrationPlan(body.session_id, auth, body.overrides);

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_approve",
      collabTaskId: result.task.id,
      metadata: {
        category: "orchestration",
        action: "approve",
        session_id: body.session_id,
        task_id: result.task.id,
      },
      ok: true,
    });

    res.json({
      task_id: result.task.id,
      plan_summary: result.session.plan?.summary ?? result.task.brief ?? "",
      success_criteria: result.session.plan?.success_criteria ?? [],
      first_actor: result.session.plan?.first_actor ?? "chatgpt",
      next_instruction: `Collab task ${result.task.id} is ready. Continue with collab_continue/collab_check_turn for the selected first actor.`,
      fallback_context: buildSessionFallbackContext(result.session),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof OrchestrationConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof OrchestrationInvalidPlanError) {
      res.status(409).json({ error: error.message });
      return;
    }
    const pg = postgresErrorDetails(error);
    if (pg?.code === "23514" || pg?.code === "22P02" || pg?.code === "23502") {
      res.status(400).json({
        error: "Invalid orchestration approval overrides",
        details: {
          code: pg.code,
          constraint: pg.constraint,
          message: pg.message,
        },
      });
      return;
    }
    if (pg?.code === "23503" || pg?.code === "23505") {
      res.status(409).json({
        error: "Orchestration approval conflict",
        details: {
          code: pg.code,
          constraint: pg.constraint,
          message: pg.message,
        },
      });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_approve",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to approve orchestration plan",
    });
    res.status(500).json({ error: "Failed to approve orchestration plan" });
  }
});

router.post("/actions/orchestrate_abort", chatGptActionAuthMiddleware, requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = orchestrateAbortSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const session = await abortOrchestrationSession(body.session_id, auth, body.reason);

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_abort",
      metadata: {
        category: "orchestration",
        action: "abort",
        session_id: body.session_id,
      },
      ok: true,
    });

    res.json({ session_id: session.id, status: session.status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/orchestrate_abort",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to abort orchestration session",
    });
    res.status(500).json({ error: "Failed to abort orchestration session" });
  }
});

router.get("/collab/tasks", chatGptActionAuthMiddleware, requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;
    const tasks = await listTasks({ filter: "all" }, auth);
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/tasks",
      metadata: {
        category: "collab",
        action: "list_tasks",
        count: tasks.length,
      },
      ok: true,
    });
    res.json({ tasks });
  } catch (error) {
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/tasks",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to list collab tasks",
    });
    console.error("Error listing collab tasks for ChatGPT:", error);
    res.status(500).json({ error: "Failed to list collab tasks" });
  }
});

router.post("/actions/collab_continue", chatGptActionAuthMiddleware, requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = collabContinueSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;

    const resolvedTaskId = body.task_id ?? extractTaskIdFromText(body.message);
    if (!resolvedTaskId) {
      res.status(400).json({
        ok: false,
        error: "No collab task ID found. Provide task_id or include a task UUID in message.",
        user_visible: "No collab task ID found. Include the task UUID and retry.",
      });
      return;
    }

    const claim = await claimTurn(resolvedTaskId, "chatgpt", auth);
    let task = claim ?? await getTask(resolvedTaskId, auth);
    if (!task) {
      res.status(404).json({
        ok: false,
        task_id: resolvedTaskId,
        error: "Task not found",
        user_visible: `Task ${resolvedTaskId} was not found.`,
      });
      return;
    }
    const preparedUploadHydration = await hydrateTaskWithRecentPreparedUploads(task, auth);
    if (preparedUploadHydration) {
      task = await getTask(task.id, auth) ?? task;
    }
    const inlineDocuments = await inlineDocumentsFromTaskContext(task, auth);

    const nextActor = task.state === "CREATIVE" ? "chatgpt" : task.state === "TECHNICAL" ? "claude" : null;
    const lastMessage = task.transcript.length > 0 ? task.transcript[task.transcript.length - 1] : null;

    if (!claim) {
      const continueCommand = buildFirstTurnContinueCommand(task);
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/collab/continue",
        collabTaskId: task.id,
        metadata: {
          category: "collab",
          action: "continue",
          is_my_turn: false,
          state: task.state,
          iteration: task.iteration,
          next_actor: nextActor,
        },
        ok: true,
      });
      res.json({
        ok: true,
        submitted: false,
        is_my_turn: false,
        task_id: task.id,
        state: task.state,
        iteration: task.iteration,
        max_iterations: task.maxIterations,
        next_actor: nextActor,
        user_visible: appendContinueCommand(`Task ${task.id} is waiting on ${nextActor ?? "completion"}.`, continueCommand),
        continue_command: continueCommand,
        last_message: lastMessage,
        recent_transcript: task.transcript.slice(-6),
        fallback_context: buildTurnFallbackContext(task, "chatgpt"),
        ...(inlineDocuments.length ? { inline_documents: inlineDocuments } : {}),
        ...(preparedUploadHydration ? { upload: preparedUploadHydration.attached } : {}),
      });
      return;
    }

    const canWrite =
      auth.authMode !== "oauth" || hasRequiredScopes(auth.scopes ?? [], ["collab:write"]);

    if (!body.draft_output || body.draft_output.trim().length === 0) {
      const continueCommand = buildFirstTurnContinueCommand(task);
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/collab/continue",
        collabTaskId: task.id,
        metadata: {
          category: "collab",
          action: "continue",
          is_my_turn: true,
          submitted: false,
          state: task.state,
          iteration: task.iteration,
          next_actor: nextActor,
        },
        ok: true,
      });
      res.json({
        ok: true,
        submitted: false,
        is_my_turn: true,
        task_id: task.id,
        state: task.state,
        iteration: task.iteration,
        max_iterations: task.maxIterations,
        next_actor: nextActor,
        user_visible: appendContinueCommand(`It's your turn on task ${task.id}. Draft the output, then call collab_continue again with draft_output.`, continueCommand),
        continue_command: continueCommand,
        last_message: lastMessage,
        recent_transcript: task.transcript.slice(-6),
        fallback_context: buildTurnFallbackContext(task, "chatgpt"),
        ...(inlineDocuments.length ? { inline_documents: inlineDocuments } : {}),
        ...(preparedUploadHydration ? { upload: preparedUploadHydration.attached } : {}),
      });
      return;
    }

    if (!canWrite) {
      res.status(403).json({
        ok: false,
        task_id: task.id,
        error: "Insufficient OAuth scopes",
        requiredScopes: ["collab:write"],
        user_visible: "Write permission is required to submit this collab turn.",
      });
      return;
    }

    const submittedTask = await submitTurn(task.id, "chatgpt", body.draft_output, auth, { markDone: body.mark_done });
    const savedTurn = submittedTask.transcript.length > 0 ? submittedTask.transcript[submittedTask.transcript.length - 1] : null;
    const continueCommand = buildFirstTurnContinueCommand(submittedTask);
    const nextAfterSubmit = submittedTask.state === "CREATIVE"
      ? "chatgpt"
      : submittedTask.state === "TECHNICAL"
        ? "claude"
        : null;

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/continue",
      collabTaskId: submittedTask.id,
      metadata: {
        category: "collab",
        action: "continue_submit",
        is_my_turn: true,
        submitted: true,
        state: submittedTask.state,
        iteration: submittedTask.iteration,
        next_actor: nextAfterSubmit,
        content_preview: savedTurn ? previewText(savedTurn.content, 700) : previewText(body.draft_output, 700),
        content_length: savedTurn ? savedTurn.content.length : body.draft_output.length,
      },
      ok: true,
    });

    res.json({
      ok: true,
      submitted: true,
      is_my_turn: true,
      task_id: submittedTask.id,
      state: submittedTask.state,
      iteration: submittedTask.iteration,
      max_iterations: submittedTask.maxIterations,
      next_actor: nextAfterSubmit,
      user_visible: appendContinueCommand(`Saved ChatGPT turn for task ${submittedTask.id} at iteration ${submittedTask.iteration}.`, continueCommand),
      continue_command: continueCommand,
      saved_turn: savedTurn
        ? {
            actor: savedTurn.actor,
            iteration: savedTurn.iteration,
            ts: savedTurn.ts,
            content: savedTurn.content,
            content_length: savedTurn.content.length,
            content_preview: savedTurn.content.slice(0, 800),
          }
        : null,
      recent_transcript: submittedTask.transcript.slice(-6),
      fallback_context: buildTurnFallbackContext(submittedTask, "chatgpt"),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof CollabConflictError) {
      const auth = await resolveChatGptActionAuth(req, res);
      if (!auth) return;
      const taskIdFromBody = readBodyTaskId(req.body) ?? extractTaskIdFromText(typeof req.body?.message === "string" ? req.body.message : "");
      const task = taskIdFromBody ? await getTask(taskIdFromBody, auth) : null;
      const nextActor = task ? (task.state === "CREATIVE" ? "chatgpt" : task.state === "TECHNICAL" ? "claude" : null) : null;
      res.status(409).json({
        ok: false,
        error: error.message,
        task_id: taskIdFromBody ?? null,
        state: task?.state ?? null,
        iteration: task?.iteration ?? null,
        max_iterations: task?.maxIterations ?? null,
        next_actor: nextActor,
        user_visible: task
          ? `Turn rejected. Task ${task.id} is currently waiting on ${nextActor ?? "completion"}.`
          : "Turn rejected due to task state mismatch.",
      });
      return;
    }
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/continue",
      collabTaskId: readBodyTaskId(req.body),
      ok: false,
      error: error instanceof Error ? error.message : "Failed to continue collab task",
    });
    console.error("Error continuing collab task for ChatGPT:", error);
    res.status(500).json({ error: "Failed to continue collab task" });
  }
});

router.post("/collab/create-task", chatGptActionAuthMiddleware, requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = collabCreateTaskSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;

    const task = await createCollabTask(
      {
        title: body.title,
        brief: body.brief ?? null,
        firstActor: body.first_actor,
        maxIterations: body.max_iterations,
      },
      auth
    );

    const continueCommand = buildFirstTurnContinueCommand(task);
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/create-task",
      collabTaskId: task.id,
      metadata: {
        category: "collab",
        action: "create_task",
        title_preview: previewText(task.title, 160),
        state: task.state,
        iteration: task.iteration,
        max_iterations: task.maxIterations,
      },
      ok: true,
    });
    res.status(201).json({
      ok: true,
      task_id: task.id,
      title: task.title,
      brief: task.brief,
      state: task.state,
      iteration: task.iteration,
      max_iterations: task.maxIterations,
      user_visible: appendContinueCommand(`Created collab task ${task.id} (${task.title}).`, continueCommand),
      continue_command: continueCommand,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/create-task",
      collabTaskId: readBodyTaskId(req.body),
      ok: false,
      error: error instanceof Error ? error.message : "Failed to create collab task",
    });
    console.error("Error creating collab task for ChatGPT:", error);
    res.status(500).json({ error: "Failed to create collab task" });
  }
});

router.post("/collab/run-turn", chatGptActionAuthMiddleware, requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = collabTaskIdSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;

    const claim = await claimTurn(body.task_id, "chatgpt", auth);
    let task = claim ?? await getTask(body.task_id, auth);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const preparedUploadHydration = await hydrateTaskWithRecentPreparedUploads(task, auth);
    if (preparedUploadHydration) {
      task = await getTask(task.id, auth) ?? task;
    }
    const inlineDocuments = await inlineDocumentsFromTaskContext(task, auth);

    const lastMessage = task.transcript.length > 0
      ? task.transcript[task.transcript.length - 1]
      : null;

    const nextActor = task.state === "CREATIVE" ? "chatgpt" : task.state === "TECHNICAL" ? "claude" : null;
    const continueCommand = buildFirstTurnContinueCommand(task);
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/run-turn",
      collabTaskId: task.id,
      metadata: {
        category: "collab",
        action: "run_turn",
        is_my_turn: Boolean(claim),
        state: task.state,
        iteration: task.iteration,
        next_actor: nextActor,
      },
      ok: true,
    });
    res.json({
      is_my_turn: Boolean(claim),
      task_id: task.id,
      title: task.title,
      brief: task.brief,
      state: task.state,
      iteration: task.iteration,
      max_iterations: task.maxIterations,
      next_actor: nextActor,
      user_visible: appendContinueCommand(claim
        ? `It's your turn on task ${task.id} (iteration ${task.iteration + 1}).`
        : `Task ${task.id} is waiting on ${nextActor ?? "completion"}.`, continueCommand),
      continue_command: continueCommand,
      last_message: lastMessage,
      recent_transcript: task.transcript.slice(-6),
      context: task.context,
      fallback_context: buildTurnFallbackContext(task, "chatgpt"),
      ...(inlineDocuments.length ? { inline_documents: inlineDocuments } : {}),
      ...(preparedUploadHydration ? { upload: preparedUploadHydration.attached } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/run-turn",
      collabTaskId: readBodyTaskId(req.body),
      ok: false,
      error: error instanceof Error ? error.message : "Failed to check collab turn",
    });
    console.error("Error checking collab turn for ChatGPT:", error);
    res.status(500).json({ error: "Failed to check collab turn" });
  }
});

router.post("/collab/submit-turn", chatGptActionAuthMiddleware, requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = collabSubmitTurnSchema.parse(req.body ?? {});
    const auth = await resolveChatGptActionAuth(req, res);
    if (!auth) return;

    const task = await submitTurn(body.task_id, "chatgpt", body.content, auth, { markDone: body.mark_done });
    const nextActor = task.state === "CREATIVE" ? "chatgpt" : task.state === "TECHNICAL" ? "claude" : null;
    const savedTurn = task.transcript.length > 0 ? task.transcript[task.transcript.length - 1] : null;
    const continueCommand = buildFirstTurnContinueCommand(task);
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/submit-turn",
      collabTaskId: task.id,
      metadata: {
        category: "collab",
        action: "submit_turn",
        actor: "chatgpt",
        state: task.state,
        iteration: task.iteration,
        next_actor: nextActor,
        content_preview: savedTurn ? previewText(savedTurn.content, 700) : previewText(body.content, 700),
        content_length: savedTurn ? savedTurn.content.length : body.content.length,
      },
      ok: true,
    });
    res.json({
      ok: true,
      task_id: task.id,
      state: task.state,
      iteration: task.iteration,
      max_iterations: task.maxIterations,
      next_actor: nextActor,
      user_visible: appendContinueCommand(`Saved ChatGPT turn for task ${task.id} at iteration ${task.iteration}.`, continueCommand),
      continue_command: continueCommand,
      saved_turn: savedTurn
        ? {
            actor: savedTurn.actor,
            iteration: savedTurn.iteration,
            ts: savedTurn.ts,
            content: savedTurn.content,
            content_length: savedTurn.content.length,
            content_preview: savedTurn.content.slice(0, 800),
          }
        : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof CollabConflictError) {
      const auth = await resolveChatGptActionAuth(req, res);
      if (!auth) return;
      const taskId = readBodyTaskId(req.body);
      const task = taskId ? await getTask(taskId, auth) : null;
      const nextActor = task ? (task.state === "CREATIVE" ? "chatgpt" : task.state === "TECHNICAL" ? "claude" : null) : null;
      res.status(409).json({
        ok: false,
        error: error.message,
        task_id: taskId,
        state: task?.state ?? null,
        iteration: task?.iteration ?? null,
        max_iterations: task?.maxIterations ?? null,
        next_actor: nextActor,
        user_visible: task
          ? `Turn rejected. Task ${task.id} is currently waiting on ${nextActor ?? "completion"}.`
          : "Turn rejected due to task state mismatch.",
      });
      return;
    }
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/collab/submit-turn",
      collabTaskId: readBodyTaskId(req.body),
      ok: false,
      error: error instanceof Error ? error.message : "Failed to submit collab turn",
    });
    console.error("Error submitting collab turn for ChatGPT:", error);
    res.status(500).json({ error: "Failed to submit collab turn" });
  }
});

export default router;
