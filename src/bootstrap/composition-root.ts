import type { Express } from "express";
import http from "node:http";

import { config } from "../config/index.js";
import { initDb } from "../infrastructure/db/index.js";
import { createApp } from "../transport/http/app.js";
import { TalleiOAuthProvider } from "../transport/mcp/oauth.js";
import { startWorkers, stopWorkers } from "./workers.js";
import type { AppServices } from "./container.js";

function buildRateLimitStub(): import("express").RequestHandler {
  return (_req, _res, next) => next();
}

export function buildContainer(): AppServices {
  const issuerUrl = new URL(config.publicBaseUrl);
  const mcpPublicUrl = new URL(config.mcpPublicUrl || `${config.publicBaseUrl}/mcp`);
  const oauthProvider = new TalleiOAuthProvider(mcpPublicUrl);
  const allowedOrigins = [
    ...new Set(
      [
        config.dashboardBaseUrl,
        config.frontendUrl,
        config.publicBaseUrl,
        ...(config.nodeEnv !== "production"
          ? [
              "http://localhost:3001",
              "http://127.0.0.1:3001",
              "http://localhost:3000",
              "http://127.0.0.1:3000",
            ]
          : []),
      ].filter(Boolean)
    ),
  ];

  const app = createApp({
    allowedOrigins,
    oauthProvider,
    issuerUrl,
    mcpPublicUrl,
    memoryRateLimit: buildRateLimitStub(),
    mcpRateLimit: buildRateLimitStub(),
  });

  let server: http.Server | null = null;

  return {
    app,
    mcpPublicUrl,
    async start() {
      await initDb();
      startWorkers();
      server = app.listen(config.port, config.host, () => {
        console.log(`[tallei] listening on http://${config.host}:${config.port}`);
      });
    },
    async stop() {
      stopWorkers();
      await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
