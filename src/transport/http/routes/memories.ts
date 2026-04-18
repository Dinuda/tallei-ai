import { Router, Response } from "express";
import { z } from "zod";
import {
  saveMemory,
  recallMemories,
  listMemories,
  deleteMemory,
} from "../../../services/memory.js";
import {
  getMemoryGraphSnapshot,
  listMemoryEntities,
  recallMemoriesV2,
} from "../../../orchestration/graph/recall-v2.usecase.js";
import { getMemoryGraphInsights } from "../../../orchestration/graph/graph-insights.usecase.js";
import { config } from "../../../config/index.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

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

const recallV2Schema = z.object({
  q: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  graph_depth: z.coerce.number().int().min(1).max(2).optional().default(1),
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

// --- GET /api/memories/recall-v2 ---
router.get("/recall-v2", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  if (!config.recallV2Enabled) {
    res.status(404).json({ error: "recall-v2 is disabled" });
    return;
  }

  try {
    const query = recallV2Schema.parse(req.query);
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await recallMemoriesV2(
      query.q,
      req.authContext,
      query.limit,
      query.graph_depth,
      req.ip
    );

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error recalling memories v2:", error);
    res.status(500).json({ error: "Failed to recall memories v2" });
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

// --- GET /api/memories/graph ---
router.get("/graph", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  if (!config.dashboardGraphV2Enabled) {
    res.status(404).json({ error: "memory graph v2 is disabled" });
    return;
  }

  try {
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const graph = await getMemoryGraphSnapshot(req.authContext);
    res.json(graph);
  } catch (error) {
    console.error("Error fetching memory graph:", error);
    res.status(500).json({ error: "Failed to load memory graph" });
  }
});

// --- GET /api/memories/entities ---
router.get("/entities", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "40"), 10) || 40));
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const entities = await listMemoryEntities(req.authContext, limit, q);
    res.json({ entities });
  } catch (error) {
    console.error("Error listing entities:", error);
    res.status(500).json({ error: "Failed to list entities" });
  }
});

// --- GET /api/memories/insights ---
router.get("/insights", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  if (!config.graphExtractionEnabled) {
    res.status(404).json({ error: "memory graph extraction is disabled" });
    return;
  }

  try {
    if (!req.authContext) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const insights = await getMemoryGraphInsights(req.authContext);
    res.json(insights);
  } catch (error) {
    console.error("Error generating memory insights:", error);
    res.status(500).json({ error: "Failed to generate memory insights" });
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
