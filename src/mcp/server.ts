import { createHash } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { z } from "zod";
import {
  saveMemory,
  recallMemories,
  listMemories,
  deleteMemory,
  prewarmRecallCache,
} from "../services/memory.js";
import { authContextFromUserId } from "../services/auth.js";
import { config } from "../config.js";
import { pool } from "../db/index.js";
import { getCacheJson, setCacheJson } from "../services/cache.js";
import { hasRequiredScopes } from "../services/oauthTokens.js";
import type { AuthContext } from "../types/auth.js";

const OAUTH_CACHE_TTL_SECONDS = 10 * 60;

interface OAuthCacheEntry {
  userId: string;
  tenantId: string;
  scopes: string[];
  clientId: string;
}

function tokenCacheKey(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `auth:oauth:${hash}`;
}

async function logMcpCallEvent(input: {
  userId?: string | null;
  tenantId?: string | null;
  keyId?: string | null;
  authMode?: "api_key" | "oauth" | "unknown";
  method: string;
  toolName?: string | null;
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO mcp_call_events (tenant_id, user_id, key_id, auth_mode, method, tool_name, ok, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.tenantId ?? null,
        input.userId ?? null,
        input.keyId ?? null,
        input.authMode ?? "unknown",
        input.method,
        input.toolName ?? null,
        input.ok,
        input.error ?? null,
      ]
    );
  } catch (error) {
    if (config.nodeEnv !== "production") {
      console.error("[mcp] failed to persist call event:", error);
    }
  }
}

function buildMcpServer(auth: AuthContext): McpServer {
  const server = new McpServer({
    name: "tallei",
    version: "1.0.0",
  });

  server.registerTool(
    "save_memory",
    {
      title: "Save Memory",
      description: "Saves information to Tallei persistent memory.",
      inputSchema: {
        content: z
          .string()
          .describe("The fact, preference, or information to remember. Be specific and concise."),
        platform: z
          .enum(["claude", "chatgpt", "gemini", "other"])
          .optional()
          .default("claude")
          .describe("The AI platform this memory is from"),
      },
    },
    async ({ content, platform }) => {
      const saved = await saveMemory(content, auth, platform ?? "claude");
      return {
        content: [{ type: "text", text: `✅ Memory saved (${saved.memoryId}).` }],
      };
    }
  );

  server.registerTool(
    "remember_user_preference",
    {
      title: "Remember User Preference",
      description: "Saves a durable user preference/fact immediately.",
      inputSchema: {
        fact: z.string().describe("The exact concise fact/preference to remember."),
        platform: z.enum(["claude", "chatgpt", "gemini", "other"]).optional().default("claude"),
      },
    },
    async ({ fact, platform }) => {
      const saved = await saveMemory(fact, auth, platform ?? "claude");
      return {
        content: [{ type: "text", text: `✅ Preference saved (${saved.memoryId}).` }],
      };
    }
  );

  server.registerTool(
    "recall_memories",
    {
      title: "Recall Memories",
      description: "Searches Tallei persistent memory and returns relevant past context.",
      inputSchema: {
        query: z
          .string()
          .describe("What to search for. Use topic keywords like 'favorite food' or 'project stack'."),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
    },
    async ({ query, limit }) => {
      const result = await recallMemories(query, auth, limit ?? 5);
      return { content: [{ type: "text", text: result.contextBlock }] };
    }
  );

  server.registerTool(
    "recall_user_context",
    {
      title: "Recall User Context",
      description: "Searches stored user context and preferences. Alias of recall_memories.",
      inputSchema: {
        query: z.string().describe("What to look up about the user/context."),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
    },
    async ({ query, limit }) => {
      const result = await recallMemories(query, auth, limit ?? 5);
      return { content: [{ type: "text", text: result.contextBlock }] };
    }
  );

  server.registerTool(
    "list_memories",
    {
      title: "List Memories",
      description: "Lists all recent memories stored in Tallei for this user.",
      inputSchema: {},
    },
    async () => {
      const memories = await listMemories(auth);
      if (memories.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }
      const text = memories.map((memory) => `• ${memory.text}`).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "delete_memory",
    {
      title: "Delete Memory",
      description: "Deletes a specific memory from Tallei by its ID.",
      inputSchema: {
        memory_id: z.string().describe("The unique ID of the memory to delete"),
      },
    },
    async ({ memory_id }) => {
      const result = await deleteMemory(memory_id, auth);
      return {
        content: [{ type: "text", text: `Deleted memory ${memory_id}. Success: ${result.success}` }],
      };
    }
  );

  return server;
}

function sendUnauthorized(res: any, resourceMetadataUrl: string, message: string): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="${message}"`
  );
  res.status(401).json({ error: message });
}

async function authFromOAuthToken(token: string, oauthVerifier: OAuthTokenVerifier): Promise<AuthContext | null> {
  const cacheKey = tokenCacheKey(token);
  const cached = await getCacheJson<OAuthCacheEntry>(cacheKey);
  if (cached?.userId && cached?.tenantId && cached?.clientId) {
    return {
      userId: cached.userId,
      tenantId: cached.tenantId,
      authMode: "oauth",
      clientId: cached.clientId,
      scopes: cached.scopes ?? [],
    };
  }

  try {
    const authInfo = await oauthVerifier.verifyAccessToken(token);
    const userIdValue = authInfo.extra?.userId;
    const tenantIdValue = authInfo.extra?.tenantId;
    if (typeof userIdValue !== "string" || userIdValue.length === 0) return null;

    const context = typeof tenantIdValue === "string" && tenantIdValue.length > 0
      ? { userId: userIdValue, tenantId: tenantIdValue, authMode: "oauth" as const }
      : await authContextFromUserId(userIdValue, "oauth");
    const scopes = Array.isArray(authInfo.scopes)
      ? authInfo.scopes.map((scope) => String(scope))
      : [];

    await setCacheJson(
      cacheKey,
      {
        userId: context.userId,
        tenantId: context.tenantId,
        clientId: authInfo.clientId,
        scopes,
      },
      OAUTH_CACHE_TTL_SECONDS
    );

    return {
      ...context,
      clientId: authInfo.clientId,
      scopes,
    };
  } catch {
    return null;
  }
}

export function createMcpRouter(oauthVerifier: OAuthTokenVerifier, resourceMetadataUrl: string): Router {
  const router = Router();

  const handleMcp = async (req: any, res: any) => {
    const method = typeof req?.body?.method === "string" ? req.body.method : "unknown";
    const toolName = typeof req?.body?.params?.name === "string" ? req.body.params.name : null;

    if (config.nodeEnv !== "production") {
      if (method === "tools/call" && typeof toolName === "string") {
        console.log(`[mcp] tools/call -> ${toolName}`);
      } else if (typeof method === "string") {
        console.log(`[mcp] ${method}`);
      }
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      await logMcpCallEvent({
        method,
        toolName,
        ok: false,
        error: "Missing or invalid Authorization header",
      });
      sendUnauthorized(res, resourceMetadataUrl, "Missing or invalid Authorization header");
      return;
    }

    const token = authHeader.split(" ")[1];
    if (token.startsWith("gm_")) {
      await logMcpCallEvent({
        method,
        toolName,
        authMode: "unknown",
        ok: false,
        error: "Legacy API keys are no longer supported on /mcp",
      });
      sendUnauthorized(res, resourceMetadataUrl, "Legacy API keys are no longer supported. Reconnect via OAuth.");
      return;
    }

    const authContext = await authFromOAuthToken(token, oauthVerifier);
    const authMode: "oauth" = "oauth";

    if (!authContext) {
      await logMcpCallEvent({
        method,
        toolName,
        authMode,
        ok: false,
        error: "Invalid or expired token",
      });
      sendUnauthorized(res, resourceMetadataUrl, "Invalid or expired token");
      return;
    }
    if (!hasRequiredScopes(authContext.scopes ?? [], ["mcp:tools"])) {
      await logMcpCallEvent({
        userId: authContext.userId,
        tenantId: authContext.tenantId,
        method,
        toolName,
        authMode,
        ok: false,
        error: "Missing mcp:tools scope",
      });
      res.status(403).json({
        error: "Insufficient OAuth scopes",
        requiredScopes: ["mcp:tools"],
      });
      return;
    }

    await logMcpCallEvent({
      userId: authContext.userId,
      tenantId: authContext.tenantId,
      keyId: null,
      authMode,
      method,
      toolName,
      ok: true,
    });

    prewarmRecallCache(authContext);

    const server = buildMcpServer(authContext);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  router.all("/", handleMcp);
  router.all("/{*path}", handleMcp);
  return router;
}
