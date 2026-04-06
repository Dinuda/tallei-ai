import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  saveMemory,
  recallMemories,
  listMemories,
  deleteMemory,
} from "../services/memory.js";
import { authMiddleware } from "../middleware/auth.js";

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
router.post("/", async (req: Request, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    const userId = (req as any).userId as string;

    const result = await saveMemory(body.content, userId, body.platform);

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
router.get("/recall", async (req: Request, res: Response) => {
  try {
    const query = recallSchema.parse(req.query);
    const userId = (req as any).userId as string;

    const result = await recallMemories(query.q, userId, query.limit);

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
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const memories = await listMemories(userId);
    res.json({ memories });
  } catch (error) {
    console.error("Error listing memories:", error);
    res.status(500).json({ error: "Failed to list memories" });
  }
});

// --- DELETE /api/memories/:id ---
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const result = await deleteMemory(String(req.params.id));
    res.json(result);
  } catch (error) {
    console.error("Error deleting memory:", error);
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

export default router;
