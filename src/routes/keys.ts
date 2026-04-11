import { Router } from "express";
import { generateApiKey, listEphemeralApiKeys, revokeApiKey } from "../services/auth.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { pool } from "../db/index.js";
import { config } from "../config.js";

const router = Router();
const listKeysTimeoutRaw =
  process.env.LIST_KEYS_TIMEOUT_MS || (config.nodeEnv === "production" ? "10000" : "2500");
const listKeysTimeoutParsed = Number.parseInt(listKeysTimeoutRaw, 10);
const LIST_KEYS_TIMEOUT_MS = Number.isFinite(listKeysTimeoutParsed)
  ? listKeysTimeoutParsed
  : (config.nodeEnv === "production" ? 10_000 : 2_500);
const LIST_KEYS_DB_COOLDOWN_MS = config.nodeEnv === "production" ? 0 : 60_000;
let listKeysDbBypassUntil = 0;

function isDbConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timed out|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|No route to host/i.test(error.message);
}

function shouldBypassListKeysDbPath(): boolean {
  return LIST_KEYS_DB_COOLDOWN_MS > 0 && Date.now() < listKeysDbBypassUntil;
}
router.use((req: AuthRequest, res, next) => {
  const internalSecret = req.headers["x-internal-secret"];

  if (!internalSecret) {
    void authMiddleware(req, res, next);
    return;
  }

  if (internalSecret !== config.internalApiSecret) {
    res.status(401).json({ error: "Invalid internal secret" });
    return;
  }

  const userIdHeader = req.headers["x-user-id"];
  const userId = typeof userIdHeader === "string"
    ? userIdHeader
    : Array.isArray(userIdHeader)
      ? userIdHeader[0]
      : undefined;

  if (!userId) {
    res.status(400).json({ error: "Missing X-User-Id header" });
    return;
  }

  const tenantHeader = req.headers["x-tenant-id"];
  const tenantId = typeof tenantHeader === "string"
    ? tenantHeader
    : Array.isArray(tenantHeader)
      ? tenantHeader[0]
      : undefined;

  req.userId = userId;
  req.authContext = tenantId
    ? { userId, tenantId, authMode: "internal" }
    : undefined;

  next();
});

router.post("/", async (req: AuthRequest, res) => {
  try {
    const { name, rotationDays, connectorType } = req.body;
    if (!name) {
      res.status(400).json({ error: "API Key requires a name" });
      return;
    }
    const validConnectorTypes = ["claude", "chatgpt", "gemini", "other"];
    if (connectorType !== undefined && connectorType !== null && !validConnectorTypes.includes(connectorType)) {
      res.status(400).json({ error: "Invalid connectorType" });
      return;
    }
    const days = Number.isFinite(Number(rotationDays)) ? Number(rotationDays) : 90;
    const result = await generateApiKey(
      req.userId!,
      name,
      Math.min(Math.max(days, 1), 365),
      req.authContext?.tenantId ?? null,
      connectorType ?? null
    );
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      res.status(409).json({ error: "An active key with this connector type already exists" });
      return;
    }
    console.error("Error generating API key:", error);
    res.status(500).json({ error: "Failed to generate API key" });
  }
});

router.get("/", async (req: AuthRequest, res) => {
  if (shouldBypassListKeysDbPath() && req.userId && config.nodeEnv !== "production") {
    const fallbackKeys = listEphemeralApiKeys(req.userId);
    res.json({ keys: fallbackKeys });
    return;
  }

  try {
    const result = await Promise.race([
      pool.query(
        `SELECT id, name, created_at, last_used_at, revoked_at, rotation_days, connector_type
         FROM api_keys
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [req.userId]
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("list keys timed out")), LIST_KEYS_TIMEOUT_MS)
      ),
    ]);
    res.json({
      keys: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
        rotationDays: row.rotation_days,
        connectorType: row.connector_type ?? null,
      })),
    });
  } catch (error) {
    if (LIST_KEYS_DB_COOLDOWN_MS > 0 && isDbConnectivityError(error)) {
      listKeysDbBypassUntil = Date.now() + LIST_KEYS_DB_COOLDOWN_MS;
    }
    if (req.userId) {
      const fallbackKeys = listEphemeralApiKeys(req.userId);
      if (fallbackKeys.length > 0) {
        res.json({ keys: fallbackKeys });
        return;
      }
      if (config.nodeEnv !== "production") {
        // Keep dashboard responsive in local/dev when upstream DB is unavailable.
        res.json({ keys: [] });
        return;
      }
    }
    console.error("Error fetching API keys:", error);
    res.status(500).json({ error: "Failed to fetch API keys" });
  }
});

router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const revoked = await revokeApiKey(req.userId!, String(req.params.id), req.authContext?.tenantId ?? null);
    res.json({ success: revoked });
  } catch (error) {
    console.error("Error deleting API key:", error);
    res.status(500).json({ error: "Failed to delete API key" });
  }
});

export default router;
