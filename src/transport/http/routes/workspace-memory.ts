import { Router, type Response } from "express";
import { z } from "zod";

import {
  deleteWorkspaceMemory,
  listWorkspaceMemories,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
} from "../../../services/workspace-memory.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();
router.use(authMiddleware);
router.use(workspaceMiddleware);

const memoryIdSchema = z.object({ memoryId: z.string().uuid() });

function sendError(res: Response, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  res.status(/not found/i.test(message) ? 404 : 500).json({ error: message });
}

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const memories = q.trim()
      ? await searchWorkspaceMemories(req.authContext!, q)
      : await listWorkspaceMemories(req.authContext!);
    res.json({ memories });
  } catch (error) {
    sendError(res, error, "Failed to list workspace memories");
  }
});

router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({
      text: z.string().trim().min(1),
      source: z.enum(["manual", "loop_run", "google_doc", "faq_import"]).optional(),
      sourceRef: z.string().nullable().optional(),
      memoryType: z.string().optional(),
      category: z.string().nullable().optional(),
    }).parse(req.body ?? {});
    res.status(201).json({ memory: await saveWorkspaceMemory(req.authContext!, body) });
  } catch (error) {
    sendError(res, error, "Failed to save workspace memory");
  }
});

router.delete("/:memoryId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { memoryId } = memoryIdSchema.parse(req.params);
    await deleteWorkspaceMemory(req.authContext!, memoryId);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, "Failed to delete workspace memory");
  }
});

export default router;
