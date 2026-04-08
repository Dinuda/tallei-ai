import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || "3000"}`,
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || "3000"}`,
  frontendUrl: process.env.FRONTEND_URL || process.env.PUBLIC_BASE_URL || "http://localhost:3001",
  internalApiSecret: process.env.INTERNAL_API_SECRET || "",
  // Public URL for the MCP endpoint (used in OAuth metadata). Defaults to {publicBaseUrl}/mcp.
  mcpPublicUrl: process.env.MCP_URL || "",
  databaseUrl: process.env.DATABASE_URL!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  jwtSecret: process.env.JWT_SECRET!,
  googleClientId: process.env.GOOGLE_CLIENT_ID!,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI!,
  browserWorkerBaseUrl: process.env.BROWSER_WORKER_BASE_URL || "",
  browserWorkerApiKey: process.env.BROWSER_WORKER_API_KEY || "",
  browserMaxStudentRetries: parseInt(process.env.BROWSER_MAX_STUDENT_RETRIES || "2", 10),
  browserLlmFallbackEnabled: (process.env.BROWSER_LLM_FALLBACK_ENABLED || "true") === "true",
  browserWorkerWsEndpoint: process.env.BROWSER_WORKER_WS_ENDPOINT || "",
  browserSessionTtlMs: parseInt(process.env.BROWSER_SESSION_TTL_MS || "900000", 10),
  browserHeadless: (process.env.BROWSER_HEADLESS || "true") === "true",
  claudeConnectorMcpUrl: process.env.CLAUDE_CONNECTOR_MCP_URL || `${process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || "3000"}`}/mcp`,
  claudeProjectInstructionsTemplate:
    process.env.CLAUDE_PROJECT_INSTRUCTIONS_TEMPLATE ||
    "Project: chatgpt memory. Before answering, call Tallei MCP recall_memories for relevant context. Persist durable user facts and long-term preferences via save_memory. Keep memory updates concise and factual.",
} as const;

// Validate required env vars at startup
const required = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "JWT_SECRET",
  "INTERNAL_API_SECRET",
] as const;
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}
