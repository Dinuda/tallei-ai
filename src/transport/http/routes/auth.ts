import { Response, Router } from "express";
import {
  getUserById,
  revokeSessionJwt,
  upsertGoogleUser,
  verifySessionToken,
} from "../../../infrastructure/auth/auth.js";
import { internalSecretMiddleware } from "../middleware/auth.middleware.js";

const router = Router();

const SESSION_COOKIE_NAME = "tallei_session";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (!rawName || rest.length === 0) continue;
    const raw = rest.join("=");
    try {
      out[rawName] = decodeURIComponent(raw);
    } catch {
      out[rawName] = raw;
    }
  }
  return out;
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
}

/**
 * POST /api/auth/sync  (internal — called by Next.js on NextAuth signIn)
 * Upserts the Google user in the database and returns our internal userId.
 */
router.post("/sync", internalSecretMiddleware, async (req, res) => {
  const { sub, email } = req.body as { sub?: string; email?: string };
  if (!sub || !email) {
    res.status(400).json({ error: "Missing sub or email" });
    return;
  }
  try {
    const user = await upsertGoogleUser({ sub, email });
    res.json({ userId: user.id, tenantId: user.tenantId });
  } catch (error) {
    console.error("User sync failed:", error);
    res.status(500).json({ error: "Failed to sync user" });
  }
});

router.post("/register", async (_req, res) => {
  res.status(410).json({ error: "Google login required" });
});

router.post("/login", async (_req, res) => {
  res.status(410).json({ error: "Google login required" });
});

router.get("/exchange-cookie", async (req, res) => {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (!token) {
      res.status(401).json({ error: "Missing session cookie" });
      return;
    }

    const payload = await verifySessionToken(token);
    const user = await getUserById(payload.id);
    if (!user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    res.json({ token, user });
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired session" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) await revokeSessionJwt(token);
    clearSessionCookie(res);
    res.json({ success: true });
  } catch (error) {
    console.error("Logout failed:", error);
    res.status(500).json({ error: "Logout failed" });
  }
});

export default router;
