import "./patch.js";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import authRouter from "./routes/auth.js";
import browserUseRouter from "./routes/browserUse.js";
import { initDb } from "./db/index.js";
import claudeOnboardingRouter from "./routes/claudeOnboarding.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import keysRouter from "./routes/keys.js";
import memoriesRouter from "./routes/memories.js";
import mcpEventsRouter from "./routes/mcpEvents.js";
import mcpCodeRouter from "./routes/mcp.js";
import chatgptRouter from "./routes/chatgpt.js";
import { createMcpRouter } from "./mcp/server.js";
import { TalleiOAuthProvider } from "./mcp/oauth.js";
import { createRateLimitMiddleware } from "./middleware/rateLimit.js";
import { createOauthExtensionsRouter } from "./routes/oauth.js";

const allowedOrigins = [
  config.frontendUrl,
  "http://localhost:3001",
  "http://127.0.0.1:3001",
].filter((origin): origin is string => Boolean(origin));

const issuerUrl = new URL(config.publicBaseUrl);
const mcpPublicUrl = new URL(config.mcpPublicUrl || new URL("/mcp", issuerUrl).toString());
const oauthProvider = new TalleiOAuthProvider(mcpPublicUrl);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpPublicUrl);
const memoryRateLimit = createRateLimitMiddleware({
  namespace: "memory-api",
  windowSeconds: 60,
  maxRequests: config.memoryApiRateLimitPerMinute,
});
const mcpRateLimit = createRateLimitMiddleware({
  namespace: "mcp",
  windowSeconds: 60,
  maxRequests: config.mcpRateLimitPerMinute,
});

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header (mcp-bridge, curl, server-to-server).
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }));

  app.use(express.json({ limit: "1mb" }));

  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl: mcpPublicUrl,
    resourceName: "Tallei",
    scopesSupported: ["mcp:tools", "memory:read", "memory:write", "automation:run"],
  }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "tallei", timestamp: new Date().toISOString() });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/oauth", createOauthExtensionsRouter());
  app.use("/api/keys", keysRouter);
  app.use("/api/memories", memoryRateLimit, memoriesRouter);
  app.use("/api/chatgpt", memoryRateLimit, chatgptRouter);
  app.use("/api/mcp/events", mcpEventsRouter);
  app.use("/api/mcp", mcpCodeRouter);
  app.use("/api/claude-onboarding", claudeOnboardingRouter);
  app.use("/api/browser-use", browserUseRouter);
  app.use("/mcp", mcpRateLimit, createMcpRouter(oauthProvider, resourceMetadataUrl));

  return app;
}

const app = createApp();

async function main() {
  await initDb();

  app.listen(config.port, "127.0.0.1", () => {
    console.log(`Tallei backend listening on http://127.0.0.1:${config.port}`);
    console.log(`Public base URL: ${config.publicBaseUrl}`);
    console.log(`MCP public URL: ${mcpPublicUrl.toString()}`);
    console.log(`Environment: ${config.nodeEnv}`);
  });
}

void main().catch((error) => {
  console.error("Failed to initialize database:", error);
  process.exit(1);
});

export default app;
