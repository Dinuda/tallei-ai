import { Router, Response } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.js";
import { config } from "../config.js";
import { recallMemories, saveMemory } from "../services/memory.js";
import { pool } from "../db/index.js";

const router = Router();

const recallSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

const saveSchema = z.object({
  content: z.string().min(1, "content is required"),
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
       VALUES ($1, $2, NULL, $3, $4, NULL, $5, $6)`,
      [
        auth.tenantId,
        auth.userId,
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

function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tallei ChatGPT Actions API",
      version: "2.0.0",
      description: "Shared-memory Actions API for ChatGPT Custom GPTs (OAuth only).",
    },
    servers: [
      {
        url: serverUrl,
      },
    ],
    components: {
      schemas: {},
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          description: "Use OAuth 2.0. Legacy API keys are no longer supported.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${serverUrl}/authorize`,
              tokenUrl: `${serverUrl}/token`,
              scopes: {
                "memory:read": "Read memory graph content",
                "memory:write": "Write/update memory graph content",
              },
            },
            clientCredentials: {
              tokenUrl: `${serverUrl}/api/oauth/token`,
              scopes: {
                "memory:read": "Read memory graph content",
                "memory:write": "Write/update memory graph content",
                "automation:run": "Run non-interactive automation jobs",
              },
            },
          },
        },
      },
    },
    paths: {
      "/api/chatgpt/actions/run": {
        post: {
          operationId: "run",
          summary: "Compatibility alias for memory recall",
          security: [{ oauth2: ["memory:read"] }],
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
      "/api/chatgpt/actions/recall": {
        post: {
          operationId: "recallMemories",
          summary: "Recall relevant memories",
          security: [{ oauth2: ["memory:read"] }],
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
          security: [{ oauth2: ["memory:write"] }],
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

router.post("/actions/recall", authMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = recallSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await recallMemories(body.query, req.authContext, body.limit, req.ip);
    await logChatGptAction({
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
      await logChatGptAction({
        auth: req.authContext,
        method: "chatgpt/actions/recall",
        ok: false,
        error: error instanceof Error ? error.message : "Transient memory infra error",
      });
      res.json(degradedRecallResponse());
      return;
    }
    await logChatGptAction({
      auth: req.authContext,
      method: "chatgpt/actions/recall",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to recall memories",
    });
    console.error("Error recalling ChatGPT memories:", error);
    res.status(500).json({ error: "Failed to recall memories" });
  }
});

router.post("/actions/run", authMiddleware, requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = recallSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await recallMemories(body.query, req.authContext, body.limit, req.ip);
    await logChatGptAction({
      auth: req.authContext,
      method: "chatgpt/actions/run",
      ok: true,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (isTransientMemoryInfraError(error)) {
      await logChatGptAction({
        auth: req.authContext,
        method: "chatgpt/actions/run",
        ok: false,
        error: error instanceof Error ? error.message : "Transient memory infra error",
      });
      res.json(degradedRecallResponse());
      return;
    }
    await logChatGptAction({
      auth: req.authContext,
      method: "chatgpt/actions/run",
      ok: false,
      error: error instanceof Error ? error.message : "Failed to run memory action",
    });
    console.error("Error running ChatGPT memory action:", error);
    res.status(500).json({ error: "Failed to run memory action" });
  }
});

router.post("/actions/save", authMiddleware, requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const saved = await saveMemory(body.content, req.authContext, "chatgpt", req.ip);
    await logChatGptAction({
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
    await logChatGptAction({
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
