import { Router } from "express";
import { generateApiKey, revokeApiKey } from "../services/auth.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { pool } from "../db/index.js";

const router = Router();
router.use(authMiddleware);

router.post("/", async (req: AuthRequest, res) => {
  try {
    const { name, rotationDays } = req.body;
    if (!name) {
      res.status(400).json({ error: "API Key requires a name" });
      return;
    }
    const days = Number.isFinite(Number(rotationDays)) ? Number(rotationDays) : 90;
    const result = await generateApiKey(req.userId!, name, Math.min(Math.max(days, 1), 365));
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error("Error generating API key:", error);
    res.status(500).json({ error: "Failed to generate API key" });
  }
});

router.get("/", async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, created_at, last_used_at, revoked_at, rotation_days
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({
      keys: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
        rotationDays: row.rotation_days,
      })),
    });
  } catch (error) {
    console.error("Error fetching API keys:", error);
    res.status(500).json({ error: "Failed to fetch API keys" });
  }
});

router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    const revoked = await revokeApiKey(req.userId!, String(req.params.id));
    res.json({ success: revoked });
  } catch (error) {
    console.error("Error deleting API key:", error);
    res.status(500).json({ error: "Failed to delete API key" });
  }
});

export default router;
