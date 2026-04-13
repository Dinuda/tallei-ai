import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  saveMemory,
  recallMemories,
  listMemories,
  deleteMemory,
} from "../services/memory.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.js";

const router = Router();

// Apply auth to all memory routes
router.use(authMiddleware);

// --- Schemas ---
const saveSchema = z.object({
  content: z.string().min(1, "content is required"),
  platform: z.enum(["claude", "chatgpt", "gemini", "other"]).default("other"),
});

const recallSchema = z.object({
  q: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

// --- POST /api/memories ---
router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await saveMemory(body.content, req.authContext, body.platform, req.ip);

    res.status(201).json({
      success: true,
      memoryId: result.memoryId,
      title: result.title,
      summary: result.summary,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error saving memory:", error);
    res.status(500).json({ error: "Failed to save memory" });
  }
});

// --- GET /api/memories/recall ---
router.get("/recall", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = recallSchema.parse(req.query);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await recallMemories(query.q, req.authContext, query.limit, req.ip);

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error recalling memories:", error);
    res.status(500).json({ error: "Failed to recall memories" });
  }
});

// --- GET /api/memories ---
router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const memories = await listMemories(req.authContext);
    res.json({ memories });
  } catch (error) {
    console.error("Error listing memories:", error);
    res.status(500).json({ error: "Failed to list memories" });
  }
});

// --- DELETE /api/memories/:id ---
router.delete("/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = await deleteMemory(String(req.params.id), req.authContext, req.ip);
    res.json(result);
  } catch (error) {
    if (error instanceof Error && /not found|not owned/i.test(error.message)) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    console.error("Error deleting memory:", error);
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

export default router;
