import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest, requireScopes, safeSecretEqual } from "../middleware/auth.middleware.js";
import { config } from "../../../config/index.js";
import { recallMemories, saveMemory, savePreference } from "../../../services/memory.js";
import { recallDocument } from "../../../services/documents.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import { authContextFromApiKey, authContextFromUserId } from "../../../infrastructure/auth/auth.js";
import { getPlanForTenant } from "../../../infrastructure/auth/tenancy.js";
import { hasRequiredScopes, validateOAuthAccessToken } from "../../../infrastructure/auth/oauth-tokens.js";
import { setRequestTimingField } from "../../../observability/request-timing.js";
import { runAsyncSafe } from "../../../shared/async-safe.js";

const router = Router();
const memoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note"]);

const recallSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
  types: z.array(memoryTypeSchema).optional(),
  include_doc_refs: z.array(z.string()).max(20).optional(),
});

const saveSchema = z.object({
  content: z.string().min(1, "content is required"),
});

const runSchema = z
  .object({
    query: z.string().min(1, "query is required").optional(),
    content: z.string().min(1, "content is required").optional(),
    limit: z.coerce.number().int().min(1).max(20).optional().default(5),
  })
  .refine((value) => Boolean(value.query || value.content), {
    message: "query or content is required",
    path: ["query"],
  });

function isTransientMemoryInfraError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Qdrant|timeout|aborted|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|No route to host/i.test(error.message);
}

function degradedRecallResponse() {
  return {
    contextBlock: "--- No relevant memories found ---",
    memories: [],
  };
}

async function inlineDocumentRefs(
  refs: string[],
  auth: NonNullable<AuthRequest["authContext"]>
): Promise<string[]> {
  const uniqueRefs = [...new Set(refs.map((value) => value.trim()).filter(Boolean))];
  const blocks: string[] = [];

  for (const ref of uniqueRefs) {
    try {
      const recalled = await recallDocument(ref, auth);
      if (recalled.kind === "document") {
        blocks.push(
          [
            `ref: ${recalled.ref}`,
            `title: ${recalled.title ?? "Untitled"}`,
            `filename: ${recalled.filename ?? "-"}`,
            `status: ${recalled.status}`,
            "",
            recalled.content,
          ].join("\n")
        );
        continue;
      }

      const lotText = recalled.docs
        .map((doc) =>
          [
            `ref: ${doc.ref}`,
            `title: ${doc.title ?? "Untitled"}`,
            `filename: ${doc.filename ?? "-"}`,
            `status: ${doc.status}`,
            "",
            doc.content,
          ].join("\n")
        )
        .join("\n\n====================\n\n");

      blocks.push(
        [
          `lot: ${recalled.ref}`,
          `title: ${recalled.title ?? "Untitled lot"}`,
          `count: ${recalled.docs.length}`,
          "",
          lotText,
        ].join("\n")
      );
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        blocks.push(`ref: ${ref}\nerror: ${error.message}`);
        continue;
      }
      throw error;
    }
  }

  return blocks;
}

async function logChatGptAction(input: {
  auth: AuthRequest["authContext"];
  method:
    | "chatgpt/actions/recall"
    | "chatgpt/actions/run"
    | "chatgpt/actions/save"
    | "chatgpt/actions/save_memory"
    | "chatgpt/actions/save_preference";
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  const auth = input.auth;
  if (!auth) return;

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

function buildOpenApiSpec(serverUrl: string) {
  const memoryResultSchema = {
    type: "object",
    required: ["success", "memoryId", "title", "summary"],
    properties: {
      success: { type: "boolean" },
      memoryId: { type: "string" },
      title: { type: "string" },
      summary: { type: "object", additionalProperties: true },
    },
  };

  const recallResultSchema = {
    type: "object",
    required: ["contextBlock", "memories"],
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
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Tallei ChatGPT Actions API",
      version: "3.1.0",
      description: "Shared-memory Actions API for ChatGPT Custom GPTs (Bearer API key).",
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
      "/api/chatgpt/actions/recall": {
        post: {
          operationId: "recallMemories",
          summary: "Recall relevant memories before answering",
          description:
            "Call this exactly once on every user turn before answering. " +
            "Use a query derived from the current user message (same topic/entities), not a fixed generic query.",
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
                        "Memory lookup query derived from the current user prompt (same topic/entities/intent). Prefer passing the latest user message verbatim.",
                    },
                    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
                    types: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: ["preference", "fact", "event", "decision", "note"],
                      },
                      description:
                        "Optional memory type scope. Use only when it helps; avoid forcing a fixed type set every turn.",
                    },
                    include_doc_refs: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Optional @doc/@lot refs to inline full document content in the recall response contextBlock.",
                    },
                  },
                  example: {
                    query: "do you think that customer segment will buy at my price?",
                    types: ["fact", "decision", "preference"],
                    include_doc_refs: ["@doc:pricing-memo-ab12"],
                    limit: 5,
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Memory recall results",
              content: {
                "application/json": {
                  schema: recallResultSchema,
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/save_memory": {
        post: {
          operationId: "saveMemoryAction",
          summary: "Save durable memory",
          "x-openai-isConsequential": true,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["content"],
                  properties: {
                    content: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Memory saved",
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
      "/api/chatgpt/actions/save_preference": {
        post: {
          operationId: "savePreferenceAction",
          summary: "Save a durable pinned preference",
          "x-openai-isConsequential": true,
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["content"],
                  properties: {
                    content: { type: "string" },
                    category: { type: "string" },
                    preference_key: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Preference saved",
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

router.post("/actions/recall", chatGptActionAuthMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = recallSchema.parse(req.body);
    const result = await recallMemories(body.query, req.authContext!, body.limit, req.ip, {
      types: body.types,
    });

    const refs = [...new Set((body.include_doc_refs ?? []).map((value) => value.trim()).filter(Boolean))];
    if (refs.length > 0) {
      const docBlocks = await inlineDocumentRefs(refs, req.authContext!);
      if (docBlocks.length > 0) {
        result.contextBlock = `${result.contextBlock}\n\n---\nInlined Documents\n\n${docBlocks.join("\n\n====================\n\n")}`;
      }
    }

    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/recall",
      ok: true,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (isTransientMemoryInfraError(error)) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/recall",
        ok: false,
        error: error instanceof Error ? error.message : "Transient memory infra error",
      });
      res.json(degradedRecallResponse());
      return;
    }
    if (error instanceof PlanRequiredError) {
      res.status(402).json({ error: error.message });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/recall",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to recall memories",
    });
    console.error("Error recalling ChatGPT memories:", error);
    res.status(500).json({ error: "Failed to recall memories" });
  }
});

router.post("/actions/run", chatGptActionAuthMiddleware, requireScopes([]), async (req: AuthRequest, res: Response) => {
  try {
    const body = runSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const auth = req.authContext!;
    const isPrivileged = auth.authMode === "internal" || auth.authMode === "api_key";

    if (body.query) {
      if (!isPrivileged && !hasRequiredScopes(auth.scopes ?? [], ["memory:read"])) {
        res.status(403).json({ error: "Insufficient OAuth scopes", requiredScopes: ["memory:read"] });
        return;
      }

      const result = await recallMemories(body.query, auth, body.limit, req.ip);
      logChatGptActionAsync({ auth, method: "chatgpt/actions/run", ok: true });
      res.json(result);
      return;
    }

    if (!isPrivileged && !hasRequiredScopes(auth.scopes ?? [], ["memory:write"])) {
      res.status(403).json({ error: "Insufficient OAuth scopes", requiredScopes: ["memory:write"] });
      return;
    }

    const saved = await saveMemory(body.content as string, req.authContext, "chatgpt", req.ip);
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/run",
      ok: true,
    });
    res.json({
      success: true,
      memoryId: saved.memoryId,
      title: saved.title,
      summary: saved.summary,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (isTransientMemoryInfraError(error)) {
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/run",
        ok: false,
        error: error instanceof Error ? error.message : "Transient memory infra error",
      });
      res.json(degradedRecallResponse());
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/run",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to run memory action",
    });
    console.error("Error running ChatGPT memory action:", error);
    res.status(500).json({ error: "Failed to run memory action" });
  }
});

router.post("/actions/save_memory", chatGptActionAuthMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    const saved = await saveMemory(body.content, req.authContext!, "chatgpt", req.ip);
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/save_memory",
      ok: true,
    });
    res.json({
      success: true,
      memoryId: saved.memoryId,
      title: saved.title,
      summary: saved.summary,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/save_memory",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to save memory",
    });
    console.error("Error saving ChatGPT memory:", error);
    res.status(500).json({ error: "Failed to save memory" });
  }
});

router.post("/actions/save_preference", chatGptActionAuthMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.extend({
      category: z.string().optional(),
      preference_key: z.string().optional(),
    }).parse(req.body);
    const saved = await savePreference(body.content, req.authContext!, "chatgpt", req.ip, {
      category: body.category ?? null,
      preferenceKey: body.preference_key ?? null,
    });
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/save_preference",
      ok: true,
    });
    res.json({
      success: true,
      memoryId: saved.memoryId,
      title: saved.title,
      summary: saved.summary,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/save_preference",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to save preference",
    });
    console.error("Error saving ChatGPT preference:", error);
    res.status(500).json({ error: "Failed to save preference" });
  }
});

router.post("/actions/save", chatGptActionAuthMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    const saved = await saveMemory(body.content, req.authContext!, "chatgpt", req.ip);
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/save",
      ok: true,
    });
    res.json({
      success: true,
      memoryId: saved.memoryId,
      title: saved.title,
      summary: saved.summary,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logChatGptActionAsync({
      auth: req.authContext,
      method: "chatgpt/actions/save",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to save memory",
    });
    console.error("Error saving ChatGPT memory:", error);
    res.status(500).json({ error: "Failed to save memory" });
  }
});

export default router;
