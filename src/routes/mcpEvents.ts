import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { pool } from "../db/index.js";

const router = Router();

router.use(authMiddleware);

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get("/", async (req, res) => {
  try {
    const { limit } = querySchema.parse(req.query);
    const userId = (req as any).userId as string;

    const result = await pool.query(
      `SELECT id, auth_mode, method, tool_name, ok, error, created_at
       FROM mcp_call_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.json({
      events: result.rows.map((row) => ({
        id: row.id,
        authMode: row.auth_mode,
        method: row.method,
        toolName: row.tool_name,
        ok: row.ok,
        error: row.error,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error fetching MCP events:", error);
    res.status(500).json({ error: "Failed to fetch MCP events" });
  }
});

export default router;
