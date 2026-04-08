import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { validateApiKey } from "../services/auth.js";

export interface AuthRequest extends Request {
  userId?: string;
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
  req.userId = userId;
  next();
}

/**
 * Public middleware: accepts Bearer API keys (gm_*), JWTs, or internal secret.
 */
export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // Internal server-to-server call from Next.js
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
    req.userId = userId;
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.split(" ")[1];

  // API Key (gm_*)
  if (token.startsWith("gm_")) {
    try {
      const userId = await validateApiKey(token);
      if (!userId) {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }
      req.userId = userId;
      next();
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Server error validating API key" });
    }
  } else {
    // JWT
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as { id: string };
      req.userId = decoded.id;
      next();
    } catch (e) {
      res.status(401).json({ error: "Invalid or expired JWT token" });
    }
  }
}
