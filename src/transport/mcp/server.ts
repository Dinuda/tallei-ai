import { createHash } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

import { authContextFromUserId } from "../../infrastructure/auth/auth.js";
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { getCacheJson, setCacheJson } from "../../infrastructure/cache/redis-cache.js";
import { hasRequiredScopes } from "../../infrastructure/auth/oauth-tokens.js";
import { runAsyncSafe } from "../../shared/async-safe.js";
import { setRequestTimingField } from "../../observability/request-timing.js";
import { prewarmRecallCache } from "../../services/memory.js";
import type { AuthContext, Plan } from "../../domain/auth/index.js";
import { registerTools } from "./tools/index.js";

const OAUTH_CACHE_TTL_SECONDS = 10 * 60;
const OAUTH_LOCAL_CACHE_TTL_MS = 10_000;

interface OAuthCacheEntry {
  userId: string;
  tenantId: string;
  scopes: string[];
  clientId: string;
  plan?: Plan;
}

interface OAuthLocalCacheEntry {
  exp: number;
  entry: OAuthCacheEntry;
}

const oauthLocalCache = new Map<string, OAuthLocalCacheEntry>();

function tokenCacheKey(token: string): string {
  return `auth:oauth:${createHash("sha256").update(token).digest("hex")}`;
}

function readLocalOAuthCache(cacheKey: string): OAuthCacheEntry | null {
  const cached = oauthLocalCache.get(cacheKey);
  if (!cached) return null;
  if (cached.exp <= Date.now()) {
    oauthLocalCache.delete(cacheKey);
    return null;
  }
  return cached.entry;
}

function writeLocalOAuthCache(cacheKey: string, entry: OAuthCacheEntry): void {
  oauthLocalCache.set(cacheKey, { entry, exp: Date.now() + OAUTH_LOCAL_CACHE_TTL_MS });
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

function logMcpCallEventAsync(input: Parameters<typeof logMcpCallEvent>[0]): void {
  setRequestTimingField("event_log_mode", "async");
  runAsyncSafe(() => logMcpCallEvent(input), "mcp call event");
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

  const local = readLocalOAuthCache(cacheKey);
  if (local?.userId && local?.tenantId && local?.clientId) {
    setRequestTimingField("auth_cache_layer", "l1");
    return { userId: local.userId, tenantId: local.tenantId, authMode: "oauth", plan: local.plan ?? "free", clientId: local.clientId, scopes: local.scopes ?? [] };
  }

  const remote = await getCacheJson<OAuthCacheEntry>(cacheKey);
  if (remote?.userId && remote?.tenantId && remote?.clientId) {
    setRequestTimingField("auth_cache_layer", "l2");
    writeLocalOAuthCache(cacheKey, remote);
    return { userId: remote.userId, tenantId: remote.tenantId, authMode: "oauth", plan: remote.plan ?? "free", clientId: remote.clientId, scopes: remote.scopes ?? [] };
  }

  try {
    setRequestTimingField("auth_cache_layer", "db");
    const authInfo = await oauthVerifier.verifyAccessToken(token);
    const userIdValue = authInfo.extra?.userId;
    if (typeof userIdValue !== "string" || userIdValue.length === 0) return null;
    if (typeof authInfo.clientId !== "string") return null;

    const context = await authContextFromUserId(userIdValue, "oauth");
    const scopes = Array.isArray(authInfo.scopes) ? authInfo.scopes.map(String) : [];
    const entry: OAuthCacheEntry = { userId: context.userId, tenantId: context.tenantId, plan: context.plan, clientId: authInfo.clientId, scopes };

    writeLocalOAuthCache(cacheKey, entry);
    await setCacheJson(cacheKey, entry, OAUTH_CACHE_TTL_SECONDS);

    return { ...context, clientId: authInfo.clientId, scopes };
  } catch (err) {
    console.error("[mcp] token verification failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

const TALLEI_INSTRUCTIONS = `Tallei stores durable memory across AI tools. Follow these rules on every turn:

1. DON'T RECALL REFLEXIVELY. Only call recall_memories when the user references prior sessions ("last time", "remember", "what did I say about"), asks about preferences, or the task clearly requires personalized past context. If you can answer from the attached file or the current message, do not call recall_memories.
2. PINNED PREFERENCES are already available as the "Pinned Preferences" MCP resource. Do not call recall_memories just to look up the user's known preferences.
3. RECALL INCLUDES DOCUMENT PARITY. recall_memories can include matched document context and inline full content for referenced/matched refs. Keep preferences first, then document context, then other memories.
4. DOCUMENT DISCOVERY ORDER: use recent_documents first (latest 5). If needed, call search_documents, then recall_document for full text.
5. USE REMEMBER AS THE SAVE ENTRY POINT. Prefer one remember call instead of chaining multiple save tools.
6. DOCUMENT SAVES — TWO MODES:
   a) FAST NOTE (default): remember(kind="document-note", title="...", key_points=["item 1","item 2",...], summary="..."). Put meaningful content into key_points (up to 10). Do NOT pass content.
   b) FULL ARCHIVE (only for "archive", "full stash", "store the whole file"): remember(kind="document-blob", content="<full text>", title="..."). Warn the user this can take longer.
7. AUTO-SAVE WITH UNDO (required when new structured content appears): If this turn includes new content the user may need later (uploaded file, pasted doc/spec/transcript, list/table/data, extracted PDF text), auto-save without asking:
   - For file refs use recall_memories(openaiFileIdRefs=[...]) or upload_blob/openaiFileIdRefs handoff and then upload_status when needed.
   - For text-only structured content, call remember(kind="document-note", ...) in the same turn.
   - Then append exactly this footer on its own line in the final reply:
     📎 Auto-saved as @doc:<ref> · reply **undo** to delete
   - Skip auto-save only if: user explicitly said not to save, the turn is purely conversational, or this content was already saved.
8. UNDO HANDLING: If the user replies "undo", "del", or "delete" after that footer, call undo_save with the referenced @doc ref immediately.`;

const MCP_SERVER_VERSION = "1.0.0";

function resolveMcpBrandBaseUrl(): string {
  const candidates = [config.dashboardBaseUrl, config.frontendUrl, config.publicBaseUrl];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).toString();
    } catch {
      continue;
    }
  }
  return "https://tallei.com/";
}

function createConfiguredMcpServer(authContext: AuthContext): McpServer {
  const brandBaseUrl = resolveMcpBrandBaseUrl();
  const server = new McpServer(
    {
      name: "tallei",
      title: "Tallei Memory",
      version: MCP_SERVER_VERSION,
      description: "Persistent memory and document context tools for AI assistants.",
      websiteUrl: brandBaseUrl,
      icons: [
        {
          src: new URL("/icon-192.png", brandBaseUrl).toString(),
          mimeType: "image/png",
          sizes: ["192x192"],
        },
        {
          src: new URL("/icon-512.png", brandBaseUrl).toString(),
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    },
    { instructions: TALLEI_INSTRUCTIONS }
  );
  registerTools(server, authContext);
  return server;
}

export function createMcpRouter(oauthVerifier: OAuthTokenVerifier, resourceMetadataUrl: string): Router {
  const router = Router();

  const handleMcp = async (req: any, res: any) => {
    const rpcMethod = typeof req?.body?.method === "string" ? req.body.method.slice(0, 128) : null;
    const toolName = typeof req?.body?.params?.name === "string" ? req.body.params.name.slice(0, 128) : null;
    const isRecallToolCall = toolName === "recall_memories";
    const method = rpcMethod ?? `transport:${String(req?.method || "unknown").toLowerCase()}`;
    const authStartedAt = process.hrtime.bigint();

    const noteAuthTiming = () => {
      const authMs = Number(process.hrtime.bigint() - authStartedAt) / 1_000_000;
      setRequestTimingField("auth_ms", authMs);
      if (isRecallToolCall) setRequestTimingField("recall_auth_ms", authMs);
    };

    if (config.nodeEnv !== "production") {
      if (rpcMethod === "tools/call" && typeof toolName === "string") console.log(`[mcp] tools/call -> ${toolName}`);
      else if (rpcMethod === "initialize") console.log("[mcp] initialize");
      else if (typeof rpcMethod === "string") console.log(`[mcp] ${rpcMethod}`);
      else console.log(`[mcp] ${method}`);
    }

    if (config.nodeEnv !== "production" && process.env["EVAL_MODE"] === "true") {
      const remoteIp = req.ip || req.socket?.remoteAddress || "";
      const isLoopback = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
      if (isLoopback) {
        const evalHeader = req.headers.authorization as string | undefined;
        const evalToken = evalHeader?.startsWith("Bearer eval:") ? evalHeader.slice("Bearer eval:".length) : null;
        if (evalToken) {
          const evalAuth = await authContextFromUserId(evalToken.trim(), "oauth").catch(() => null);
          if (evalAuth) {
            noteAuthTiming();
            req.authContext = evalAuth;
            prewarmRecallCache(evalAuth);
            const server = createConfiguredMcpServer(evalAuth);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
          }
        }
      }
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      noteAuthTiming();
      logMcpCallEventAsync({ method, toolName, ok: false, error: "Missing or invalid Authorization header" });
      sendUnauthorized(res, resourceMetadataUrl, "Missing or invalid Authorization header");
      return;
    }

    const token = authHeader.split(" ")[1];
    if (token.startsWith("gm_")) {
      noteAuthTiming();
      logMcpCallEventAsync({ method, toolName, authMode: "unknown", ok: false, error: "Legacy API keys are no longer supported on /mcp" });
      sendUnauthorized(res, resourceMetadataUrl, "Legacy API keys are no longer supported. Reconnect via OAuth.");
      return;
    }

    const authContext = await authFromOAuthToken(token, oauthVerifier);
    if (!authContext) {
      noteAuthTiming();
      logMcpCallEventAsync({ method, toolName, authMode: "oauth", ok: false, error: "Invalid or expired token" });
      sendUnauthorized(res, resourceMetadataUrl, "Invalid or expired token");
      return;
    }

    if (!hasRequiredScopes(authContext.scopes ?? [], ["mcp:tools"])) {
      noteAuthTiming();
      logMcpCallEventAsync({ userId: authContext.userId, tenantId: authContext.tenantId, method, toolName, authMode: "oauth", ok: false, error: "Missing mcp:tools scope" });
      res.status(403).json({ error: "Insufficient OAuth scopes", requiredScopes: ["mcp:tools"] });
      return;
    }

    noteAuthTiming();
    logMcpCallEventAsync({ userId: authContext.userId, tenantId: authContext.tenantId, keyId: null, authMode: "oauth", method, toolName, ok: true });

    req.authContext = authContext;
    prewarmRecallCache(authContext);

    const server = createConfiguredMcpServer(authContext);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    const dispatchStartedAt = process.hrtime.bigint();
    await transport.handleRequest(req, res, req.body);
    const dispatchMs = Number(process.hrtime.bigint() - dispatchStartedAt) / 1_000_000;
    if (isRecallToolCall) setRequestTimingField("recall_mcp_dispatch_ms", dispatchMs);
  };

  router.all("/", handleMcp);
  router.all("/{*path}", handleMcp);
  return router;
}
