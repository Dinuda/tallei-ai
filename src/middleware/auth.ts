import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import {
  authContextFromApiKey,
  authContextFromUserId,
} from "../services/auth.js";
import type { AuthContext } from "../types/auth.js";

export interface AuthRequest extends Request {
  userId?: string;
  authContext?: AuthContext;
}

function requesterIp(req: Request): string | undefined {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return forwardedFor[0].split(",")[0].trim();
  }
  return req.ip || undefined;
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
    ? { userId, tenantId: tenantIdFromHeader, authMode: "internal" as const }
    : await authContextFromUserId(userId, "internal");

  req.userId = userId;
  req.authContext = context;
  next();
}

/**
 * Public middleware: accepts Bearer API keys (gm_*), JWTs, or internal secret.
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
      ? { userId, tenantId, authMode: "internal" }
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

  if (token.startsWith("gm_")) {
    try {
      const context = await authContextFromApiKey(token, requesterIp(req));
      if (!context) {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }
      req.userId = context.userId;
      req.authContext = context;
      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Server error validating API key" });
    }
    return;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as Record<string, unknown>;
    const userId =
      typeof decoded.id === "string"
        ? decoded.id
        : typeof decoded.sub === "string"
          ? decoded.sub
          : "";
    if (!userId) {
      res.status(401).json({ error: "Invalid JWT payload" });
      return;
    }

    const tenantId = typeof decoded.tenant_id === "string" ? decoded.tenant_id : undefined;
    req.userId = userId;
    req.authContext = tenantId
      ? { userId, tenantId, authMode: "jwt" }
      : await authContextFromUserId(userId, "jwt");

    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired JWT token" });
  }
}
