import { Router } from "express";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.js";
import { pool } from "../db/index.js";

const router = Router();

router.use(authMiddleware);

const CONNECTING_WINDOW_MS = 2 * 60 * 1000;

type IntegrationState = "not_connected" | "connecting" | "connected" | "error";

type IntegrationEventRow = {
  method: string;
  ok: boolean;
  error: string | null;
  created_at: Date;
};

type IntegrationStatus = {
  state: IntegrationState;
  connected: boolean;
  lastConnectedAt: Date | null;
  lastEventAt: Date | null;
  lastError: string | null;
};

function toMillis(value: Date): number {
  return value.getTime();
}

function isRecent(value: Date, windowMs: number): boolean {
  return Date.now() - toMillis(value) <= windowMs;
}

function isNewer(a: Date, b: Date): boolean {
  return toMillis(a) > toMillis(b);
}

function deriveClaudeStatus(events: IntegrationEventRow[]): IntegrationStatus {
  const latest = events[0] ?? null;
  const latestError = events.find((event) => !event.ok) ?? null;
  const lastSuccess = events.find((event) => event.ok) ?? null;
  const lastToolSuccess = events.find((event) => event.ok && event.method === "tools/call") ?? null;
  const lastInitializeSuccess = events.find((event) => event.ok && event.method === "initialize") ?? null;

  if (!latest) {
    return {
      state: "not_connected",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
    };
  }

  if (latestError && (!lastSuccess || isNewer(latestError.created_at, lastSuccess.created_at))) {
    return {
      state: "error",
      connected: false,
      lastConnectedAt: lastToolSuccess?.created_at ?? lastInitializeSuccess?.created_at ?? null,
      lastEventAt: latest.created_at,
      lastError: latestError.error ?? "Connection attempt failed",
    };
  }

  if (lastToolSuccess) {
    return {
      state: "connected",
      connected: true,
      lastConnectedAt: lastToolSuccess.created_at,
      lastEventAt: latest.created_at,
      lastError: null,
    };
  }

  if (lastInitializeSuccess) {
    const initializing = isRecent(lastInitializeSuccess.created_at, CONNECTING_WINDOW_MS);
    return {
      state: initializing ? "connecting" : "connected",
      connected: !initializing,
      lastConnectedAt: initializing ? null : lastInitializeSuccess.created_at,
      lastEventAt: latest.created_at,
      lastError: null,
    };
  }

  if (lastSuccess && isRecent(lastSuccess.created_at, CONNECTING_WINDOW_MS)) {
    return {
      state: "connecting",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: latest.created_at,
      lastError: null,
    };
  }

  return {
    state: "not_connected",
    connected: false,
    lastConnectedAt: null,
    lastEventAt: latest.created_at,
    lastError: latestError?.error ?? null,
  };
}

function deriveChatGptStatus(events: IntegrationEventRow[]): IntegrationStatus {
  const latest = events[0] ?? null;
  const latestError = events.find((event) => !event.ok) ?? null;
  const lastSuccess = events.find((event) => event.ok) ?? null;

  if (!latest) {
    return {
      state: "not_connected",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastError: null,
    };
  }

  if (latestError && (!lastSuccess || isNewer(latestError.created_at, lastSuccess.created_at))) {
    return {
      state: "error",
      connected: false,
      lastConnectedAt: lastSuccess?.created_at ?? null,
      lastEventAt: latest.created_at,
      lastError: latestError.error ?? "Action call failed",
    };
  }

  if (lastSuccess) {
    return {
      state: "connected",
      connected: true,
      lastConnectedAt: lastSuccess.created_at,
      lastEventAt: latest.created_at,
      lastError: null,
    };
  }

  return {
    state: "not_connected",
    connected: false,
    lastConnectedAt: null,
    lastEventAt: latest.created_at,
    lastError: latestError?.error ?? null,
  };
}

router.get("/status", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await pool.query<IntegrationEventRow>(
      `SELECT method, ok, error, created_at
       FROM mcp_call_events
       WHERE user_id = $1
         AND (
           method LIKE 'chatgpt/actions/%'
           OR auth_mode = 'oauth'
         )
       ORDER BY created_at DESC
       LIMIT 250`,
      [userId]
    );

    const rows = result.rows;
    const claudeEvents = rows.filter((row) => !row.method.startsWith("chatgpt/actions/"));
    const chatgptEvents = rows.filter((row) => row.method.startsWith("chatgpt/actions/"));

    const claude = deriveClaudeStatus(claudeEvents);
    const chatgpt = deriveChatGptStatus(chatgptEvents);

    res.json({
      integrations: {
        claude,
        chatgpt,
      },
      polledAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching integration status:", error);
    res.status(500).json({ error: "Failed to fetch integration status" });
  }
});

export default router;
