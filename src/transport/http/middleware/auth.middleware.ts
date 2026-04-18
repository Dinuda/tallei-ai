import type { Request, Response, NextFunction } from "express";
import { config } from "../../../config/index.js";
import {
  authContextFromUserId,
} from "../../../infrastructure/auth/auth.js";
import { getPlanForTenant } from "../../../infrastructure/auth/tenancy.js";
import { hasRequiredScopes, validateOAuthAccessToken } from "../../../infrastructure/auth/oauth-tokens.js";
import type { AuthContext } from "../../../domain/auth/index.js";

export interface AuthRequest extends Request {
  userId?: string;
  authContext?: AuthContext;
}

function sendLegacyApiKeyMigrationError(res: Response): void {
  res.status(401).json({
    error: "Legacy API keys are no longer supported",
    message: "Reconnect your connector via OAuth at /dashboard/setup and retry.",
  });
}

/**
 * Internal middleware: validates X-Internal-Secret only.
 * Used for server-to-server calls that do not yet have a user context.
 */
export async function internalSecretMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const secret = req.headers["x-internal-secret"];
  if (!secret || secret !== config.internalApiSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Internal middleware: validates X-Internal-Secret + X-User-Id headers.
 * Used for server-to-server calls that require an explicit user context.
 */
export async function internalMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const secret = req.headers["x-internal-secret"];
  if (!secret || secret !== config.internalApiSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const userId = req.headers["x-user-id"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "Missing X-User-Id header" });
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

/**
 * Public middleware: accepts OAuth bearer tokens or internal secret.
 */
export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const internalSecret = req.headers["x-internal-secret"];
  if (internalSecret) {
    if (internalSecret !== config.internalApiSecret) {
      res.status(401).json({ error: "Invalid internal secret" });
      return;
    }
    const userId = req.headers["x-user-id"] as string | undefined;
    if (!userId) {
      res.status(400).json({ error: "Missing X-User-Id header" });
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

  const token = authHeader.split(" ")[1];
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

    const plan = await getPlanForTenant(tokenContext.tenantId);
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

    if (auth.authMode === "internal") {
      next();
      return;
    }

    const scopes = auth.scopes ?? [];
    if (!hasRequiredScopes(scopes, requiredScopes)) {
      res.status(403).json({
        error: "Insufficient OAuth scopes",
        requiredScopes,
      });
      return;
    }

    next();
  }
}
