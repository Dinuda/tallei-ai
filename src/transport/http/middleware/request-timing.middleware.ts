import type { NextFunction, Request, Response } from "express";
import { config } from "../../../config/index.js";
import {
  createRequestTimingStore,
  runWithRequestTimingStore,
  type RequestTimingValue,
} from "../../../observability/request-timing.js";
import { getRedisHealthState } from "../../../infrastructure/cache/redis-cache.js";

type TimingSurface = "mcp" | "chatgpt_actions";
type TimingOperation = "save" | "recall_v1" | "recall_v2";

interface TimingTarget {
  surface: TimingSurface;
  operation: TimingOperation;
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

function looksLikeNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function inferChatGptActionTarget(req: Request): TimingTarget | null {
  if (req.method !== "POST") return null;
  const path = stripQuery(req.originalUrl || req.url || "");

  if (
    path === "/api/chatgpt/actions/save" ||
    path === "/api/chatgpt/actions/save_memory" ||
    path === "/api/chatgpt/actions/save_preference"
  ) {
    return {
      surface: "chatgpt_actions",
      operation: "save",
      route: path,
    };
  }

  if (path === "/api/chatgpt/actions/recall") {
    return {
      surface: "chatgpt_actions",
      operation: "recall_v1",
      route: path,
    };
  }

  if (path !== "/api/chatgpt/actions/run") return null;

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  if (looksLikeNonEmptyString(body?.query)) {
    return {
      surface: "chatgpt_actions",
      operation: "recall_v1",
      route: path,
    };
  }
  if (looksLikeNonEmptyString(body?.content)) {
    return {
      surface: "chatgpt_actions",
      operation: "save",
      route: path,
    };
  }

  return null;
}

function inferMcpTarget(req: Request): TimingTarget | null {
  const path = stripQuery(req.originalUrl || req.url || "");
  if (!path.startsWith("/mcp")) return null;

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  const rpcMethod = typeof body?.method === "string" ? body.method : "";
  if (rpcMethod !== "tools/call") return null;

  const params = body?.params && typeof body.params === "object"
    ? (body.params as Record<string, unknown>)
    : null;
  const toolName = typeof params?.name === "string" ? params.name : "";
  if (!toolName) return null;

  if (toolName === "save_memory" || toolName === "save_preference") {
    return { surface: "mcp", operation: "save", route: path, toolName };
  }

  if (toolName === "recall_memories") {
    return { surface: "mcp", operation: "recall_v1", route: path, toolName };
  }

  if (toolName === "recall_memories_v2") {
    return {
      surface: "mcp",
      operation: "recall_v2",
      route: path,
      toolName,
    };
  }

  return null;
}

function resolveTimingTarget(req: Request): TimingTarget | null {
  return inferChatGptActionTarget(req) ?? inferMcpTarget(req);
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

function escapeLogValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

function formatTimingField(key: string, value: RequestTimingValue): string {
  if (typeof value === "number") {
    const normalized = Number.isFinite(value) ? value : 0;
    if (key.endsWith("_ms")) {
      return `${key}=${normalized.toFixed(2)}`;
    }
    return `${key}=${normalized}`;
  }
  if (typeof value === "boolean") {
    return `${key}=${value}`;
  }
  return `${key}="${escapeLogValue(value)}"`;
}

export function requestTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const target = resolveTimingTarget(req);
  if (!target) {
    next();
    return;
  }

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
    const authMs = typeof store.fields.auth_ms === "number" ? store.fields.auth_ms : 0;
    const recallMs = typeof store.fields.recall_total_ms === "number" ? store.fields.recall_total_ms : 0;
    const rateLimitMs = typeof store.fields.rate_limit_ms === "number" ? store.fields.rate_limit_ms : 0;
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
    const parts = [
      `surface=${target.surface}`,
      `operation=${target.operation}`,
      `method=${req.method}`,
      `route="${escapeLogValue(target.route)}"`,
      `status=${res.statusCode}`,
      `ok=${res.statusCode >= 200 && res.statusCode < 400}`,
      `duration_ms=${elapsedMs.toFixed(2)}`,
      `user_id=${auth.userId ?? "unknown"}`,
      `tenant_id=${auth.tenantId ?? "unknown"}`,
      `redis_mode=${redis.mode}`,
      `redis_cooldown_until_ms=${redis.cooldownUntilMs}`,
    ];
    if (redis.lastError) {
      parts.push(`redis_last_error="${escapeLogValue(redis.lastError)}"`);
    }
    if (target.toolName) {
      parts.push(`tool="${escapeLogValue(target.toolName)}"`);
    }
    for (const key of Object.keys(store.fields).sort()) {
      parts.push(formatTimingField(key, store.fields[key]));
    }
    console.log(`[timing] ${parts.join(" ")}`);
  });

  runWithRequestTimingStore(store, () => {
    next();
  });
}
