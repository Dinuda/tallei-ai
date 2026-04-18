import { Router } from "express";
import { randomBytes } from "node:crypto";
import { pool } from "../../../infrastructure/db/index.js";
import { internalMiddleware, AuthRequest } from "../middleware/auth.middleware.js";
import { config } from "../../../config/index.js";
import { authContextFromUserId } from "../../../infrastructure/auth/auth.js";

const router = Router();

const AUTH_CODE_TTL_SECONDS = 10 * 60;
const DEFAULT_SCOPE = "mcp:tools memory:read memory:write";

/**
 * POST /api/mcp/code  (internal only)
 *
 * Called by the Next.js /authorize page after verifying a NextAuth session.
 * Issues an MCP OAuth authorization code for the given client + user.
 *
 * Body: { clientId, codeChallenge, redirectUri, scope?, state?, resource? }
 * Returns: { code, redirectUri, state }
 */
router.post("/code", internalMiddleware, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const authContext = req.authContext ?? (await authContextFromUserId(userId, "internal"));
  const { clientId, codeChallenge, redirectUri, scope, state, resource } = req.body as {
    clientId?: string;
    codeChallenge?: string;
    redirectUri?: string;
    scope?: string;
    state?: string;
    resource?: string;
  };

  if (!clientId || !codeChallenge || !redirectUri) {
    res.status(400).json({ error: "Missing required fields: clientId, codeChallenge, redirectUri" });
    return;
  }

  try {
    // Validate client exists
    const clientResult = await pool.query<{ client_info: { redirect_uris: string[] } }>(
      "SELECT client_info FROM oauth_clients WHERE client_id = $1",
      [clientId]
    );
    if (!clientResult.rows[0]) {
      res.status(400).json({ error: "Unknown client" });
      return;
    }

    const client = clientResult.rows[0].client_info;
    if (!client.redirect_uris.includes(redirectUri)) {
      res.status(400).json({ error: "Unregistered redirect_uri" });
      return;
    }

    const code = `tla_code_${randomBytes(32).toString("hex")}`;
    const scopeValue = scope || DEFAULT_SCOPE;
    const resourceValue = resource || config.mcpPublicUrl || new URL("/mcp", config.publicBaseUrl).toString();

    await pool.query(
      `INSERT INTO oauth_authorization_codes
       (code, client_id, tenant_id, user_id, code_challenge, redirect_uri, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9::int * INTERVAL '1 second'))`,
      [
        code,
        clientId,
        authContext.tenantId,
        userId,
        codeChallenge,
        redirectUri,
        scopeValue,
        resourceValue,
        AUTH_CODE_TTL_SECONDS,
      ]
    );

    res.json({ code, redirectUri, state: state || null });
  } catch (error) {
    console.error("Failed to issue MCP auth code:", error);
    res.status(500).json({ error: "Failed to issue authorization code" });
  }
});

export default router;
