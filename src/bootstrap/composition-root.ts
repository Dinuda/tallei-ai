import type { Server } from "node:http";

import { config } from "../config/index.js";
import { initDb } from "../infrastructure/db/index.js";
import { TalleiOAuthProvider } from "../transport/mcp/oauth.js";
import { createRateLimitMiddleware } from "../transport/http/middleware/rate-limit.middleware.js";
import { createApp } from "../transport/http/app.js";
import { startWorkers, stopWorkers } from "./workers.js";
import type { AppServices } from "./container.js";

function listenAsync(
  app: ReturnType<typeof createApp>,
  port: number,
  host: string
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("error", reject);
    server.once("listening", () => resolve(server));
  });
}

export function composeAppServices(): AppServices {
  const allowedOrigins = [
    config.frontendUrl,
    "http://localhost:3001",
    "http://127.0.0.1:3001",
  ].filter((origin): origin is string => Boolean(origin));

  const issuerUrl = new URL(config.publicBaseUrl);
  const mcpPublicUrl = new URL(config.mcpPublicUrl || new URL("/mcp", issuerUrl).toString());
  const oauthProvider = new TalleiOAuthProvider(mcpPublicUrl);

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

  const app = createApp({
    allowedOrigins,
    oauthProvider,
    issuerUrl,
    mcpPublicUrl,
    memoryRateLimit,
    mcpRateLimit,
  });

  let server: Server | null = null;

  return {
    app,
    mcpPublicUrl,
    async start() {
      if (server) return;
      await initDb();
      startWorkers();
      server = await listenAsync(app, config.port, config.host);
      console.log(`Tallei backend listening on http://${config.host}:${config.port}`);
      console.log(`Public base URL: ${config.publicBaseUrl}`);
      console.log(`MCP public URL: ${mcpPublicUrl.toString()}`);
      console.log(`Environment: ${config.nodeEnv}`);
    },
    async stop() {
      stopWorkers();
      if (!server) return;
      const current = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        current.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
