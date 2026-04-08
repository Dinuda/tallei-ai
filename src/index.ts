import "./patch.js";
import express from "express";
import { config } from "./config.js";
import memoriesRouter from "./routes/memories.js";
import authRouter from "./routes/auth.js";
import keysRouter from "./routes/keys.js";
import mcpCodeRouter from "./routes/mcp.js";
import claudeOnboardingRouter from "./routes/claudeOnboarding.js";
import browserUseRouter from "./routes/browserUse.js";
import { createMcpRouter } from "./mcp/server.js";
import { TalleiOAuthProvider } from "./mcp/oauth.js";
import { initDb } from "./db/index.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import cors from "cors";

const app = express();

// CORS: allow the Next.js frontend origin only (+ localhost for dev)
const allowedOrigins = [
  config.frontendUrl,
  "http://localhost:3001",
  "http://127.0.0.1:3001",
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no Origin (mcp-bridge, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.set("trust proxy", 1);

// Body parsing
app.use(express.json({ limit: "1mb" }));

// MCP OAuth — issuer = public base URL (ngrok frontend URL in dev)
const issuerUrl = new URL(config.publicBaseUrl);
// Public MCP endpoint URL (proxied through Next.js at /mcp by default)
const mcpPublicUrlStr = config.mcpPublicUrl || new URL("/mcp", issuerUrl).toString();
const mcpUrl = new URL(mcpPublicUrlStr);
const oauthProvider = new TalleiOAuthProvider(mcpUrl);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl,
  resourceServerUrl: mcpUrl,
  resourceName: "Tallei",
  scopesSupported: ["mcp:tools"],
}));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "tallei", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api/auth", authRouter);
app.use("/api/keys", keysRouter);
app.use("/api/memories", memoriesRouter);
app.use("/api/mcp", mcpCodeRouter);
app.use("/api/claude-onboarding", claudeOnboardingRouter);
app.use("/api/browser-use", browserUseRouter);
app.use("/mcp", createMcpRouter(oauthProvider, resourceMetadataUrl));

// Start — bind to localhost only; Next.js frontend is the public face
initDb().then(() => {
  app.listen(config.port, "127.0.0.1", () => {
    console.log(`🧠 Tallei backend on http://127.0.0.1:${config.port}`);
    console.log(`   Public base URL : ${config.publicBaseUrl}`);
    console.log(`   MCP public URL  : ${mcpPublicUrlStr}`);
    console.log(`   Environment     : ${config.nodeEnv}`);
  });
}).catch(e => {
  console.error("Failed to initialize database:", e);
  process.exit(1);
});

export default app;
