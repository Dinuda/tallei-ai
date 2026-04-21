import express, { type Express, type Request, type RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";

import authRouter from "./routes/auth.js";
import browserUseRouter from "./routes/browserUse.js";
import claudeOnboardingRouter from "./routes/claudeOnboarding.js";
import keysRouter from "./routes/keys.js";
import memoriesRouter from "./routes/memories.js";
import documentsRouter from "./routes/documents.js";
import mcpEventsRouter from "./routes/mcpEvents.js";
import mcpCodeRouter from "./routes/mcp.js";
import chatgptRouter from "./routes/chatgpt.js";
import integrationsRouter from "./routes/integrations.js";
import billingRouter from "./routes/billing.js";
import { createMcpRouter } from "../mcp/server.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requestTimingMiddleware } from "./middleware/request-timing.middleware.js";
import { errorHandlerMiddleware } from "./middleware/error-handler.middleware.js";
import { createOauthExtensionsRouter } from "./routes/oauth.js";
import { getRedisHealthState } from "../../infrastructure/cache/redis-cache.js";
import { TalleiOAuthProvider } from "../mcp/oauth.js";

export interface AppFactoryDeps {
  readonly allowedOrigins: readonly string[];
  readonly oauthProvider: TalleiOAuthProvider;
  readonly issuerUrl: URL;
  readonly mcpPublicUrl: URL;
  readonly memoryRateLimit: RequestHandler;
  readonly mcpRateLimit: RequestHandler;
}

export function createApp(deps: AppFactoryDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false, // API server; no HTML responses
  }));

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header (mcp-bridge, curl, server-to-server).
      if (!origin) return callback(null, true);
      if (deps.allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }));

  app.use(
    express.json({
      limit: "3mb",
      strict: true,
      type: ["application/json"],
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(requestTimingMiddleware);

  app.use(mcpAuthRouter({
    provider: deps.oauthProvider,
    issuerUrl: deps.issuerUrl,
    resourceServerUrl: deps.mcpPublicUrl,
    resourceName: "Tallei",
    scopesSupported: ["mcp:tools", "memory:read", "memory:write", "automation:run"],
  }));

  app.get("/health", (_req, res) => {
    const redis = getRedisHealthState();
    res.json({
      status: "ok",
      service: "tallei",
      timestamp: new Date().toISOString(),
      cache: {
        redis_mode: redis.mode,
        redis_last_error: redis.lastError,
        redis_cooldown_until_ms: redis.cooldownUntilMs,
      },
    });
  });

  app.use("/api/auth", authRouter);
  app.get("/chatgpt/actions/openapi.json", (_req, res) => {
    res.redirect(302, "/api/chatgpt/actions/openapi.json");
  });
  app.use("/api/oauth", createOauthExtensionsRouter());
  app.use("/api/keys", keysRouter);
  app.use("/api/memories", deps.memoryRateLimit, memoriesRouter);
  app.use("/api/documents", deps.memoryRateLimit, documentsRouter);
  app.use("/api/chatgpt", deps.memoryRateLimit, chatgptRouter);
  app.use("/api/integrations", integrationsRouter);
  app.use("/api/billing", billingRouter);
  app.use("/api/mcp/events", mcpEventsRouter);
  app.use("/api/mcp", mcpCodeRouter);
  app.use("/api/claude-onboarding", claudeOnboardingRouter);
  app.use("/api/browser-use", browserUseRouter);

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(deps.mcpPublicUrl);
  app.use("/mcp", deps.mcpRateLimit, createMcpRouter(deps.oauthProvider, resourceMetadataUrl));

  app.use(errorHandlerMiddleware);

  return app;
}
