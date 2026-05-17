import type { Response } from "express";
import type { AuthContext } from "../../../domain/auth/index.js";
import { config } from "../../../config/index.js";
import { authContextFromUserId } from "../../../infrastructure/auth/auth.js";
import { safeSecretEqual, type AuthRequest } from "../middleware/auth.middleware.js";

export async function resolveChatGptInternalAuth(req: AuthRequest, res: Response): Promise<AuthContext | null> {
  const internalSecret = req.headers["x-internal-secret"];
  if (!internalSecret) return null;

  if (!safeSecretEqual(String(internalSecret), config.internalApiSecret)) {
    res.status(401).json({ error: "Invalid internal secret" });
    return null;
  }

  const userId = req.headers["x-user-id"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "Missing X-User-Id header" });
    return null;
  }

  const tenantId = req.headers["x-tenant-id"] as string | undefined;
  const auth = tenantId
    ? { userId, tenantId, authMode: "internal" as const, plan: "free" as const }
    : await authContextFromUserId(userId, "internal");

  req.userId = auth.userId;
  req.authContext = auth;
  return auth;
}
