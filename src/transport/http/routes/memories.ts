import { Router, Response } from "express";
import { z } from "zod";
import {
  saveMemory,
  savePreference,
  recallMemories,
  listMemoriesPage,
  listPreferences,
  forgetPreference,
  deleteMemory,
  importChatGptMemories,
} from "../../../services/memory.js";
import {
  getMemoryCleanupRun,
  listMemoryCleanupRuns,
  resetMemoryCleanupReviewFlags,
  runMemoryCleanupForUser,
  sendMemoryCleanupAdminEmail,
} from "../../../services/memory-cleanup.js";
import {
  listLoopMinerRunsForUser,
  queueLoopMinerRunForUser,
} from "../../../orchestration/loop-miner/loop-miner.js";
import { createLogger } from "../../../observability/index.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();
const logger = createLogger({ baseFields: { component: "memories_http_routes" } });

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

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const cleanupRunSchema = z.object({
  dryRun: z.boolean().optional(),
  maxMemories: z.number().int().min(1).max(500).optional(),
  processAll: z.boolean().optional(),
  includeReviewed: z.boolean().optional(),
  logImplicitKeeps: z.boolean().optional(),
  emailAdmin: z.boolean().optional(),
});

const loopMinerRunSchema = z.object({
  lookbackDays: z.number().int().min(1).max(90).optional(),
});

const chatGptImportSchema = z.object({
  input: z.string().min(1, "input is required"),
  apply: z.boolean().optional(),
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

router.post("/import/chatgpt", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = chatGptImportSchema.parse(req.body ?? {});
    const result = await importChatGptMemories(req.authContext!, {
      input: body.input,
      apply: body.apply ?? false,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error importing ChatGPT memories:", error);
    const detail = error instanceof Error ? error.message : undefined;
    res.status(500).json({
      error: "Failed to import ChatGPT memories",
      ...(detail ? { detail } : {}),
    });
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

router.post("/cleanup/run", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = cleanupRunSchema.parse(req.body ?? {});
    const run = await runMemoryCleanupForUser(req.authContext!, {
      runReason: "manual",
      dryRun: body.dryRun ?? true,
      maxMemories: body.maxMemories,
      processAll: body.processAll ?? true,
      includeReviewed: body.includeReviewed ?? false,
      logImplicitKeeps: body.logImplicitKeeps ?? false,
    });
    const adminEmail = body.emailAdmin === false
      ? { sent: false, skipped: true, to: null, error: "disabled by request" }
      : await sendMemoryCleanupAdminEmail({
          auth: req.authContext!,
          run,
          source: "manual",
        });
    res.status(201).json({ run, adminEmail });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error running memory cleanup:", error);
    res.status(500).json({ error: "Failed to run memory cleanup" });
  }
});

router.post("/cleanup/reset", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await resetMemoryCleanupReviewFlags(req.authContext!);
    res.json(result);
  } catch (error) {
    console.error("Error resetting memory cleanup review flags:", error);
    res.status(500).json({ error: "Failed to reset memory cleanup review flags" });
  }
});

router.get("/cleanup/runs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const runs = await listMemoryCleanupRuns(req.authContext!);
    res.json({ runs });
  } catch (error) {
    console.error("Error listing memory cleanup runs:", error);
    res.status(500).json({ error: "Failed to list memory cleanup runs" });
  }
});

router.get("/cleanup/runs/:id", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const run = await getMemoryCleanupRun(req.authContext!, String(req.params.id));
    if (!run) {
      res.status(404).json({ error: "Memory cleanup run not found" });
      return;
    }
    res.json({ run });
  } catch (error) {
    console.error("Error reading memory cleanup run:", error);
    res.status(500).json({ error: "Failed to read memory cleanup run" });
  }
});

router.get("/cleanup/loop-miner/runs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const runs = await listLoopMinerRunsForUser(req.authContext!);
    res.json({ runs });
  } catch (error) {
    console.error("Error listing loop miner runs:", error);
    res.status(500).json({ error: "Failed to list loop miner runs" });
  }
});

router.post("/cleanup/loop-miner/run", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = loopMinerRunSchema.parse(req.body ?? {});
    logger.info("loop miner run requested", {
      userId: req.authContext?.userId,
      tenantId: req.authContext?.tenantId,
      lookbackDays: body.lookbackDays ?? 30,
    });

    const existingRuns = await listLoopMinerRunsForUser(req.authContext!, 5);
    const activeRun = existingRuns.find((run) => run.status === "running") ?? null;
    if (activeRun) {
      res.status(202).json({
        run: activeRun,
        queued: false,
        message: "Loop miner run already in progress. Poll /api/memories/cleanup/loop-miner/runs for completion.",
      });
      return;
    }

    const run = await queueLoopMinerRunForUser(req.authContext!, {
      runReason: "manual",
      lookbackDays: body.lookbackDays ?? 30,
    });
    logger.info("loop miner run queued response", {
      runId: run?.id ?? null,
      status: run?.status ?? null,
    });
    res.status(202).json({
      run: run ?? null,
      queued: true,
      message: "Loop miner run queued. Poll /api/memories/cleanup/loop-miner/runs for completion.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    logger.error("loop miner run request failed", {
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
    });
    res.status(500).json({
      error: "Failed to run loop miner",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = listSchema.parse(req.query);
    const page = await listMemoriesPage(req.authContext!, {
      limit: query.limit,
      offset: query.offset,
    });
    res.json({
      memories: page.memories,
      pagination: {
        limit: page.limit,
        offset: page.offset,
        total: page.total ?? page.memories.length,
        hasMore: page.hasMore,
        nextOffset: page.hasMore ? page.offset + page.memories.length : null,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
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
