import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthRequest } from "../middleware/auth.js";
import { config } from "../config.js";
import { recallMemories, saveMemory } from "../services/memory.js";
import { pool } from "../db/index.js";
import { authContextFromApiKey, authContextFromUserId } from "../services/auth.js";
import { getPlanForTenant } from "../services/tenancy.js";
import { hasRequiredScopes, validateOAuthAccessToken } from "../services/oauthTokens.js";
import { setRequestTimingField } from "../services/requestTiming.js";
import { runAsyncSafe } from "../services/asyncSafe.js";

const router = Router();

const recallSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
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

async function logChatGptAction(input: {
  auth: AuthRequest["authContext"];
  method: "chatgpt/actions/recall" | "chatgpt/actions/run" | "chatgpt/actions/save";
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
    if (internalSecret !== config.internalApiSecret) {
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

function requireChatGptScopes(requiredScopes: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (requiredScopes.length === 0) {
      next();
      return;
    }

    const auth = req.authContext;
    if (!auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (auth.authMode === "internal" || auth.authMode === "api_key") {
      next();
      return;
    }

    const scopes = auth.scopes ?? [];
    if (!hasRequiredScopes(scopes, requiredScopes)) {
      res.status(403).json({
        error: "Insufficient OAuth scopes",
        requiredScopes,
      });
      return;
    }

    next();
  };
}

function authHasRequiredScopes(auth: AuthRequest["authContext"], requiredScopes: string[]): boolean {
  if (!auth) return false;
  if (requiredScopes.length === 0) return true;
  if (auth.authMode === "internal" || auth.authMode === "api_key") return true;
  return hasRequiredScopes(auth.scopes ?? [], requiredScopes);
}

function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tallei ChatGPT Actions API",
      version: "2.0.0",
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
      "/api/chatgpt/actions/run": {
        post: {
          operationId: "run",
          summary: "Compatibility action for memory recall or save",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    content: { type: "string" },
                    limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
                  },
                  oneOf: [
                    { required: ["query"] },
                    { required: ["content"] },
                  ],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Memory action result",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      {
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
                      },
                      {
                        type: "object",
                        required: ["success", "memoryId", "title", "summary"],
                        properties: {
                          success: { type: "boolean" },
                          memoryId: { type: "string" },
                          title: { type: "string" },
                          summary: { type: "object", additionalProperties: true },
                        },
                      },
                    ],
                  }
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/recall": {
        post: {
          operationId: "recallMemories",
          summary: "Recall relevant memories",
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
              description: "Memory recall results",
              content: {
                "application/json": {
                  schema: {
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
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Insufficient scope" },
          },
        },
      },
      "/api/chatgpt/actions/save": {
        post: {
          operationId: "saveMemory",
          summary: "Save durable memory",
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
                  schema: {
                    type: "object",
                    required: ["success", "memoryId", "title", "summary"],
                    properties: {
                      success: { type: "boolean" },
                      memoryId: { type: "string" },
                      title: { type: "string" },
                      summary: { type: "object", additionalProperties: true },
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
    },
  };
}

router.get("/openapi.json", (_req, res: Response) => {
  const forwardedProto = _req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = _req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || _req.get("host") || "";
  const proto = forwardedProto || _req.protocol || "https";

  const localhostPattern = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;

  let serverUrl = "";
  if (host && !localhostPattern.test(host)) {
    serverUrl = `${proto}://${host}`;
  } else {
    try {
      const fallback = new URL(config.publicBaseUrl);
      serverUrl = `${fallback.protocol}//${fallback.host}`;
    } catch {
      if (host) {
        serverUrl = `${proto}://${host}`;
      }
    }
  }

  if (!serverUrl) {
    serverUrl = "http://127.0.0.1:3000";
  }

  res.json(buildOpenApiSpec(serverUrl));
});

router.post("/actions/recall", chatGptActionAuthMiddleware, requireChatGptScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = recallSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await recallMemories(body.query, req.authContext, body.limit, req.ip);
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

router.post("/actions/run", chatGptActionAuthMiddleware, requireChatGptScopes([]), async (req: AuthRequest, res: Response) => {
  try {
    const body = runSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (body.query) {
      if (!authHasRequiredScopes(req.authContext, ["memory:read"])) {
        res.status(403).json({
          error: "Insufficient OAuth scopes",
          requiredScopes: ["memory:read"],
        });
        return;
      }

      const result = await recallMemories(body.query, req.authContext, body.limit, req.ip);
      logChatGptActionAsync({
        auth: req.authContext,
        method: "chatgpt/actions/run",
        ok: true,
      });
      res.json(result);
      return;
    }

    if (!authHasRequiredScopes(req.authContext, ["memory:write"])) {
      res.status(403).json({
        error: "Insufficient OAuth scopes",
        requiredScopes: ["memory:write"],
      });
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

router.post("/actions/save", chatGptActionAuthMiddleware, requireChatGptScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const saved = await saveMemory(body.content, req.authContext, "chatgpt", req.ip);
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
