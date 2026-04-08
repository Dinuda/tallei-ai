import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { z } from "zod";
import { saveMemory, recallMemories, listMemories, deleteMemory, prewarmRecallCache } from "../services/memory.js";
import { validateApiKey } from "../services/auth.js";

// ── Recall classifier ────────────────────────────────────────────────────────
// Avoids an MCP round-trip for self-contained questions that don't need
// historical context. Returns false → skip recall, true → do recall.
const SELF_CONTAINED = [
  /^(what|how|explain|define|describe)\s+(is|are|does|the|a)\s+/i,
  /^(show|give|list|count|generate|write|create)\s+(me\s+)?(a|an|some|example)/i,
  /^(what'?s|whats)\s+(the\s+)?(difference|meaning|definition)/i,
];

const CONTEXT_DEPENDENT = [
  /\b(my|our|i'?ve|i\s+said|remember|previously|last\s+time|before|again)\b/i,
  /\b(project|codebase|repo|stack|prefer|usually|always|style|design|theme)\b/i,
  /\b(continue|resume|pick\s+up|where\s+we|from\s+before)\b/i,
];

function needsRecall(query: string): boolean {
  if (CONTEXT_DEPENDENT.some(p => p.test(query))) return true;
  if (SELF_CONTAINED.some(p => p.test(query))) return false;
  return true; // default: do recall — better to search than miss a relevant memory
}

// ── OAuth token cache ─────────────────────────────────────────────────────────
// verifyAccessToken() may do a DB lookup or crypto verify on every request.
// Cache the userId per token for the life of the token (up to 10 min).
const OAUTH_CACHE_TTL_MS = 10 * 60_000;
interface OAuthCacheEntry { userId: string; exp: number }
const oauthTokenCache = new Map<string, OAuthCacheEntry>();

function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: "tallei",
    version: "1.0.0",
  });

  // Tool: save_memory
  server.registerTool(
    "save_memory",
    {
      title: "Save Memory",
      description: "Saves a conversation or piece of information as a persistent memory in Tallei.",
      inputSchema: {
        content: z.string().describe("The conversation content or information to remember"),
        platform: z.enum(["claude", "chatgpt", "gemini", "other"]).optional().default("claude").describe("The AI platform this memory is from"),
      },
    },
    async ({ content, platform }) => {
      // save_memory is fire-and-forget: the heavy work (summarise + embed + store)
      // runs in the background. Claude is not blocked waiting for OpenAI.
      void saveMemory(content, userId, platform ?? "claude");
      return {
        content: [{
          type: "text",
          text: "✅ Memory captured and queuing for storage.",
        }],
      };
    }
  );

  // Tool: recall_memories
  server.registerTool(
    "recall_memories",
    {
      title: "Recall Memories",
      description: "Searches your past memories in Tallei and returns relevant context. Call this automatically at the start of every conversation.",
      inputSchema: {
        query: z.string().describe("What you want to recall about. E.g., 'user preferences', 'project goals', 'what is tallei'"),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
    },
    async ({ query, limit }) => {
      if (!needsRecall(query)) {
        return { content: [{ type: "text", text: "--- No context needed ---" }] };
      }
      const result = await recallMemories(query, userId, limit ?? 5);
      return { content: [{ type: "text", text: result.contextBlock }] };
    }
  );

  // Tool: list_memories
  server.registerTool(
    "list_memories",
    {
      title: "List Memories",
      description: "Lists all recent memories stored in Tallei for this user.",
      inputSchema: {},
    },
    async () => {
      const memories = await listMemories(userId);
      if (memories.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }
      const text = memories.map((m: any) => `• ${m.text}`).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // Tool: delete_memory
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
      const result = await deleteMemory(memory_id);
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

export function createMcpRouter(oauthVerifier: OAuthTokenVerifier, resourceMetadataUrl: string): Router {
  const router = Router();

  const handleMcp = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      sendUnauthorized(res, resourceMetadataUrl, "Missing or invalid Authorization header");
      return;
    }

    const token = authHeader.split(" ")[1];
    let userId: string | null = null;

    if (token.startsWith("gm_")) {
      userId = await validateApiKey(token);
    } else {
      // Check OAuth cache before calling verifyAccessToken
      const oauthCached = oauthTokenCache.get(token);
      if (oauthCached && oauthCached.exp > Date.now()) {
        userId = oauthCached.userId;
      } else {
        try {
          const authInfo = await oauthVerifier.verifyAccessToken(token);
          const userIdValue = authInfo.extra?.userId;
          if (typeof userIdValue === "string" && userIdValue.length > 0) {
            userId = userIdValue;
            oauthTokenCache.set(token, { userId, exp: Date.now() + OAUTH_CACHE_TTL_MS });
          }
        } catch {
          userId = null;
        }
      }
    }

    if (!userId) {
      sendUnauthorized(res, resourceMetadataUrl, "Invalid or expired token");
      return;
    }

    // Pre-warm recall cache in background on first request per user
    prewarmRecallCache(userId);

    const server = buildMcpServer(userId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  // Express 5: use "/" for root, "/{*path}" for sub-paths
  router.all("/", handleMcp);
  router.all("/{*path}", handleMcp);

  return router;
}
