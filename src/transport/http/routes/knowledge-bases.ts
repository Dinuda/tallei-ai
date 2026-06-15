import { Router, type Response } from "express";
import { z } from "zod";

import {
  createKnowledgeBase,
  deleteKnowledgeBaseEntry,
  listKnowledgeBaseEntries,
  listKnowledgeBindings,
  searchKnowledgeBaseEntries,
  upsertKnowledgeBaseEntry,
} from "../../../services/knowledge-base.js";
import { syncGoogleDocKnowledgeBase } from "../../../services/google-docs-sync.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();
router.use(authMiddleware);
router.use(workspaceMiddleware);

const knowledgeBaseIdSchema = z.object({ knowledgeBaseId: z.string().uuid() });
const entryIdSchema = z.object({ entryId: z.string().uuid() });

function sendError(res: Response, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  res.status(/not found/i.test(message) ? 404 : 500).json({ error: message });
}

router.get("/search", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = z.string().parse(req.query.q ?? "");
    const knowledgeBaseIds = typeof req.query.knowledgeBaseIds === "string"
      ? req.query.knowledgeBaseIds.split(",").filter(Boolean)
      : undefined;
    res.json({ entries: await searchKnowledgeBaseEntries(req.authContext!, query, knowledgeBaseIds) });
  } catch (error) {
    sendError(res, error, "Failed to search knowledge bases");
  }
});

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    res.json(await listKnowledgeBindings(req.authContext!));
  } catch (error) {
    sendError(res, error, "Failed to list knowledge bases");
  }
});

router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({
      name: z.string().trim().min(1).max(120),
      kind: z.enum(["custom_faq", "google_doc"]),
      config: z.record(z.unknown()).optional(),
    }).parse(req.body ?? {});
    res.status(201).json({ knowledgeBase: await createKnowledgeBase(req.authContext!, body) });
  } catch (error) {
    sendError(res, error, "Failed to create knowledge base");
  }
});

router.get("/:knowledgeBaseId/entries", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { knowledgeBaseId } = knowledgeBaseIdSchema.parse(req.params);
    res.json({ entries: await listKnowledgeBaseEntries(req.authContext!, knowledgeBaseId) });
  } catch (error) {
    sendError(res, error, "Failed to list knowledge base entries");
  }
});

router.post("/:knowledgeBaseId/entries", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { knowledgeBaseId } = knowledgeBaseIdSchema.parse(req.params);
    const body = z.object({
      id: z.string().uuid().optional(),
      question: z.string().trim().min(1),
      answer: z.string().trim().min(1),
      sortOrder: z.number().int().optional(),
    }).parse(req.body ?? {});
    res.json({ entry: await upsertKnowledgeBaseEntry(req.authContext!, knowledgeBaseId, body) });
  } catch (error) {
    sendError(res, error, "Failed to save knowledge base entry");
  }
});

router.delete("/:knowledgeBaseId/entries/:entryId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { knowledgeBaseId } = knowledgeBaseIdSchema.parse(req.params);
    const { entryId } = entryIdSchema.parse(req.params);
    await deleteKnowledgeBaseEntry(req.authContext!, knowledgeBaseId, entryId);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, "Failed to delete knowledge base entry");
  }
});

router.post("/:knowledgeBaseId/sync", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { knowledgeBaseId } = knowledgeBaseIdSchema.parse(req.params);
    res.json(await syncGoogleDocKnowledgeBase(req.authContext!, knowledgeBaseId));
  } catch (error) {
    sendError(res, error, "Failed to sync Google Doc");
  }
});

export default router;
