import { Router } from "express";
import { generateApiKey } from "../services/auth.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { pool } from "../db/index.js";

const router = Router();
router.use(authMiddleware);

router.post("/", async (req: AuthRequest, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: "API Key requires a name" });
      return;
    }
    const result = await generateApiKey(req.userId!, name);
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error("Error generating API key:", error);
    res.status(500).json({ error: "Failed to generate API key" });
  }
});

router.get("/", async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC", 
      [req.userId]
    );
    res.json({ keys: result.rows });
  } catch (error) {
    console.error("Error fetching API keys:", error);
    res.status(500).json({ error: "Failed to fetch API keys" });
  }
});

router.delete("/:id", async (req: AuthRequest, res) => {
  try {
    await pool.query("DELETE FROM api_keys WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting API key:", error);
    res.status(500).json({ error: "Failed to delete API key" });
  }
});

export default router;
