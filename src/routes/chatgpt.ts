import { Router, Response } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { config } from "../config.js";
import { recallMemories, saveMemory } from "../services/memory.js";

const router = Router();

function requireChatGptKey(req: AuthRequest, res: Response): boolean {
  if (req.authContext?.authMode !== "api_key" || req.authContext?.connectorType !== "chatgpt") {
    res.status(403).json({ error: "This endpoint requires a ChatGPT-scoped API key" });
    return false;
  }
  return true;
}

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

function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tallei ChatGPT Actions API",
      version: "1.0.0",
      description: "Shared-memory Actions API for ChatGPT Custom GPTs.",
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
          bearerFormat: "API Key",
          description: "Use your Tallei API key (gm_...).",
        },
      },
    },
    paths: {
      "/api/chatgpt/actions/run": {
        post: {
          operationId: "run",
          summary: "Compatibility alias for memory recall",
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

router.post("/actions/recall", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const body = recallSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!requireChatGptKey(req, res)) return;

    const result = await recallMemories(body.query, req.authContext, body.limit, req.ip);
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (isTransientMemoryInfraError(error)) {
      res.json(degradedRecallResponse());
      return;
    }
    console.error("Error recalling ChatGPT memories:", error);
    res.status(500).json({ error: "Failed to recall memories" });
  }
});

router.post("/actions/run", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const body = recallSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!requireChatGptKey(req, res)) return;

    const result = await recallMemories(body.query, req.authContext, body.limit, req.ip);
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (isTransientMemoryInfraError(error)) {
      res.json(degradedRecallResponse());
      return;
    }
    console.error("Error running ChatGPT memory action:", error);
    res.status(500).json({ error: "Failed to run memory action" });
  }
});

router.post("/actions/save", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!requireChatGptKey(req, res)) return;

    const saved = await saveMemory(body.content, req.authContext, "chatgpt", req.ip);
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
    console.error("Error saving ChatGPT memory:", error);
    res.status(500).json({ error: "Failed to save memory" });
  }
});

export default router;
