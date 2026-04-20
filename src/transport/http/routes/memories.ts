import { Router, Response } from "express";
import { z } from "zod";
import {
  saveMemory,
  savePreference,
  recallMemories,
  listMemories,
  listPreferences,
  forgetPreference,
  deleteMemory,
} from "../../../services/memory.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authMiddleware);

const saveSchema = z.object({
  content: z.string().min(1, "content is required"),
  platform: z.enum(["claude", "chatgpt", "gemini", "other"]).default("other"),
  memory_type: z.enum(["preference", "fact", "event", "decision", "note"]).optional(),
  category: z.string().optional(),
  is_pinned: z.boolean().optional(),
  preference_key: z.string().optional(),
});

const recallSchema = z.object({
  q: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  types: z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
      return undefined;
    },
    z.array(z.enum(["preference", "fact", "event", "decision", "note"])).optional()
  ),
});


router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    const result = await saveMemory(body.content, req.authContext!, body.platform, req.ip, {
      memoryType: body.memory_type,
      category: body.category ?? null,
      isPinned: body.is_pinned,
      preferenceKey: body.preference_key ?? null,
    });
    res.status(201).json({ success: true, memoryId: result.memoryId, title: result.title, summary: result.summary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error saving memory:", error);
    res.status(500).json({ error: "Failed to save memory" });
  }
});

router.post("/preferences", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body);
    const result = await savePreference(body.content, req.authContext!, body.platform, req.ip, {
      category: body.category ?? null,
      preferenceKey: body.preference_key ?? null,
    });
    res.status(201).json({ success: true, memoryId: result.memoryId, title: result.title, summary: result.summary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error saving preference:", error);
    res.status(500).json({ error: "Failed to save preference" });
  }
});

router.get("/preferences", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const preferences = await listPreferences(req.authContext!);
    res.json({ preferences });
  } catch (error) {
    console.error("Error listing preferences:", error);
    res.status(500).json({ error: "Failed to list preferences" });
  }
});

router.delete("/preferences/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await forgetPreference(String(req.params.id), req.authContext!, req.ip);
    res.json(result);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: "Preference not found" });
      return;
    }
    console.error("Error deleting preference:", error);
    res.status(500).json({ error: "Failed to delete preference" });
  }
});

router.get("/recall", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = recallSchema.parse(req.query);
    const result = await recallMemories(query.q, req.authContext!, query.limit, req.ip, {
      types: query.types,
    });
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


router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const memories = await listMemories(req.authContext!);
    res.json({ memories });
  } catch (error) {
    console.error("Error listing memories:", error);
    res.status(500).json({ error: "Failed to list memories" });
  }
});


router.delete("/:id", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await deleteMemory(String(req.params.id), req.authContext!, req.ip);
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
