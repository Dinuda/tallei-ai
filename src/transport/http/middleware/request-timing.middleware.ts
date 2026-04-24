import type { NextFunction, Request, Response } from "express";
import { config } from "../../../config/index.js";
import {
  createRequestTimingStore,
  runWithRequestTimingStore,
} from "../../../observability/request-timing.js";
import { getRedisHealthState } from "../../../infrastructure/cache/redis-cache.js";

type TimingSurface = "mcp" | "chatgpt_actions" | "api" | "health";

interface TimingTarget {
  surface: TimingSurface;
  route: string;
  toolName?: string;
}

interface AuthLike {
  userId?: string;
  tenantId?: string;
}

function stripQuery(path: string): string {
  const idx = path.indexOf("?");
  return idx >= 0 ? path.slice(0, idx) : path;
}

function readAuth(req: Request): AuthLike {
  const authCandidate = (req as Request & { authContext?: unknown }).authContext;
  if (!authCandidate || typeof authCandidate !== "object") return {};
  const auth = authCandidate as Record<string, unknown>;
  return {
    userId: typeof auth.userId === "string" ? auth.userId : undefined,
    tenantId: typeof auth.tenantId === "string" ? auth.tenantId : undefined,
  };
}

function classifySurface(path: string): TimingSurface {
  if (path === "/health") return "health";
  if (path.startsWith("/mcp")) return "mcp";
  if (path.startsWith("/api/chatgpt/actions")) return "chatgpt_actions";
  return "api";
}

function toSafeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function latencyBucket(durationMs: number): string {
  if (durationMs < 100) return "lt_100ms";
  if (durationMs < 250) return "lt_250ms";
  if (durationMs < 500) return "lt_500ms";
  if (durationMs < 1000) return "lt_1s";
  if (durationMs < 2500) return "lt_2_5s";
  if (durationMs < 5000) return "lt_5s";
  return "gte_5s";
}

function normalizeRouteForMetrics(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const normalized = segments.map((segment) => {
    if (/^[0-9]+$/.test(segment)) return ":id";
    if (/^[0-9a-f]{8,}$/i.test(segment)) return ":id";
    return segment;
  });
  return `/${normalized.join("/")}`;
}

function resolveTimingTarget(req: Request): TimingTarget {
  const route = stripQuery(req.originalUrl || req.url || "");
  const surface = classifySurface(route);
  if (surface !== "mcp" || req.method !== "POST") {
    return { surface, route };
  }

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  const rpcMethod = typeof body?.method === "string" ? body.method : "";
  if (rpcMethod !== "tools/call") {
    return { surface, route };
  }

  const params = body?.params && typeof body.params === "object"
    ? (body.params as Record<string, unknown>)
    : null;
  const toolName = typeof params?.name === "string" ? params.name : undefined;
  return { surface, route, toolName };
}

export function requestTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const target = resolveTimingTarget(req);
  const store = createRequestTimingStore();
  store.fields.event_log_mode = "none";
  store.fields.auth_usage_update_mode = "none";
  store.fields.auth_usage_update_queued = false;
  store.fields.rate_limit_ms = 0;
  const startedAt = process.hrtime.bigint();
  let endCalledAt: bigint | null = null;
  const originalEnd = res.end.bind(res);
  res.end = ((...args: Parameters<Response["end"]>) => {
    if (!endCalledAt) {
      endCalledAt = process.hrtime.bigint();
    }
    return originalEnd(...args);
  }) as Response["end"];
  res.once("finish", () => {
    if (config.nodeEnv === "test") return;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const responseWriteMs = endCalledAt
      ? Number(process.hrtime.bigint() - endCalledAt) / 1_000_000
      : 0;
    const authMs = toSafeNumber(store.fields.auth_ms);
    const recallMs = toSafeNumber(store.fields.recall_total_ms);
    const rateLimitMs = toSafeNumber(store.fields.rate_limit_ms);
    const handlerMs = Math.max(0, elapsedMs - authMs - recallMs - responseWriteMs - rateLimitMs);
    const unaccountedMs = Math.max(
      0,
      elapsedMs - (authMs + recallMs + responseWriteMs + rateLimitMs + handlerMs)
    );
    store.fields.response_write_ms = Number(responseWriteMs.toFixed(2));
    store.fields.handler_ms = Number(handlerMs.toFixed(2));
    store.fields.unaccounted_ms = Number(unaccountedMs.toFixed(2));

    const auth = readAuth(req);
    const redis = getRedisHealthState();
    const durationMs = Number(elapsedMs.toFixed(2));
    const status = res.statusCode;
    const routeForMetrics = normalizeRouteForMetrics(target.route);
    const logRecord: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      severity: "INFO",
      event: "http_request_timing",
      surface: target.surface,
      method: req.method,
      route: target.route,
      route_for_metrics: routeForMetrics,
      status,
      ok: status >= 200 && status < 400,
      duration_ms: durationMs,
      latency_bucket: latencyBucket(durationMs),
      user_id: auth.userId ?? "unknown",
      tenant_id: auth.tenantId ?? "unknown",
      redis_mode: redis.mode,
      redis_cooldown_until_ms: redis.cooldownUntilMs,
      httpRequest: {
        requestMethod: req.method,
        requestUrl: req.originalUrl || req.url,
        status,
        userAgent: req.get("user-agent") ?? undefined,
        remoteIp: req.ip,
      },
      timings: {
        auth_ms: toSafeNumber(store.fields.auth_ms),
        recall_total_ms: toSafeNumber(store.fields.recall_total_ms),
        rate_limit_ms: toSafeNumber(store.fields.rate_limit_ms),
        handler_ms: toSafeNumber(store.fields.handler_ms),
        response_write_ms: toSafeNumber(store.fields.response_write_ms),
        unaccounted_ms: toSafeNumber(store.fields.unaccounted_ms),
      },
      timing_fields: Object.fromEntries(Object.entries(store.fields).sort(([a], [b]) => a.localeCompare(b))),
    };

    if (redis.lastError) {
      logRecord.redis_last_error = redis.lastError;
    }
    if (target.toolName) {
      logRecord.tool = target.toolName;
    }
    console.log(JSON.stringify(logRecord));
  });

  runWithRequestTimingStore(store, () => {
    next();
  });
}
