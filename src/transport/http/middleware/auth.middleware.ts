import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../../../config/index.js";
import { authContextFromUserId } from "../../../infrastructure/auth/auth.js";
import { getPlanForTenant } from "../../../infrastructure/auth/tenancy.js";
import { hasRequiredScopes, validateOAuthAccessToken } from "../../../infrastructure/auth/oauth-tokens.js";
import type { AuthContext, Plan } from "../../../domain/auth/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeSecretEqual(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      timingSafeEqual(ab, ab); // keep timing constant
      return false;
    }
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export interface AuthRequest extends Request {
  userId?: string;
  authContext?: AuthContext;
}

const PLAN_CACHE_TTL_MS = 5 * 60_000;

interface PlanCacheEntry { plan: Plan; exp: number }
const planCache = new Map<string, PlanCacheEntry>();

async function cachedPlan(tenantId: string): Promise<Plan> {
  const cached = planCache.get(tenantId);
  if (cached && cached.exp > Date.now()) return cached.plan;
  const plan = await getPlanForTenant(tenantId);
  planCache.set(tenantId, { plan, exp: Date.now() + PLAN_CACHE_TTL_MS });
  return plan;
}

function sendLegacyApiKeyMigrationError(res: Response): void {
  res.status(401).json({
    error: "Legacy API keys are no longer supported",
    message: "Reconnect your connector via OAuth at /dashboard/setup and retry.",
  });
}

export async function internalSecretMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const secret = req.headers["x-internal-secret"];
  if (!secret || !safeSecretEqual(String(secret), config.internalApiSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export async function internalMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const secret = req.headers["x-internal-secret"];
  if (!secret || !safeSecretEqual(String(secret), config.internalApiSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const userId = req.headers["x-user-id"] as string | undefined;
  if (!userId || !UUID_RE.test(userId)) {
    res.status(400).json({ error: "Missing or invalid X-User-Id header" });
    return;
  }

  const tenantIdFromHeader = req.headers["x-tenant-id"] as string | undefined;
  const context = tenantIdFromHeader
    ? { userId, tenantId: tenantIdFromHeader, authMode: "internal" as const, plan: "free" as const }
    : await authContextFromUserId(userId, "internal");

  req.userId = userId;
  req.authContext = context;
  next();
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const internalSecret = req.headers["x-internal-secret"];
  if (internalSecret) {
    if (!safeSecretEqual(String(internalSecret), config.internalApiSecret)) {
      res.status(401).json({ error: "Invalid internal secret" });
      return;
    }
    const userId = req.headers["x-user-id"] as string | undefined;
    if (!userId || !UUID_RE.test(userId)) {
      res.status(400).json({ error: "Missing or invalid X-User-Id header" });
      return;
    }

    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    req.userId = userId;
    req.authContext = tenantId
      ? { userId, tenantId, authMode: "internal", plan: "free" as const }
      : await authContextFromUserId(userId, "internal");
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  if (token.startsWith("gm_")) {
    sendLegacyApiKeyMigrationError(res);
    return;
  }

  try {
    const tokenContext = await validateOAuthAccessToken(token);
    if (!tokenContext) {
      res.status(401).json({ error: "Invalid or expired OAuth token" });
      return;
    }

    const plan = await cachedPlan(tokenContext.tenantId);
    req.userId = tokenContext.userId;
    req.authContext = {
      userId: tokenContext.userId,
      tenantId: tokenContext.tenantId,
      authMode: "oauth",
      plan,
      clientId: tokenContext.clientId,
      scopes: tokenContext.scopes,
    };
    next();
  } catch (error) {
    console.error("OAuth token validation failed:", error);
    res.status(500).json({ error: "Server error validating OAuth token" });
  }
}

export function requireScopes(requiredScopes: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (requiredScopes.length === 0) {
      next();
      return;
    }

    const auth = req.authContext;
    if (!auth) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (auth.authMode === "internal" || auth.authMode === "api_key") {
      next();
      return;
    }

    if (!hasRequiredScopes(auth.scopes ?? [], requiredScopes)) {
      res.status(403).json({ error: "Insufficient OAuth scopes", requiredScopes });
      return;
    }

    next();
  };
}
