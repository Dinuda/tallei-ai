import { Router, type Response } from "express";
import { z } from "zod";

import {
  activateWorkspace,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from "../../../services/workspace/index.js";
import { createWorkspaceInputSchema, updateWorkspaceInputSchema } from "../../../services/workspace/types.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();
router.use(authMiddleware);
router.use(workspaceMiddleware);

const workspaceIdSchema = z.object({ workspaceId: z.string().uuid() });

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.errors });
    return;
  }
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message) ? 404 : /cannot|blocked|personal/i.test(message) ? 409 : 500;
  res.status(status).json({ error: message });
}

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    res.json({
      workspaces: await listWorkspaces(req.authContext!),
      activeWorkspaceId: req.authContext!.workspaceId ?? null,
    });
  } catch (error) {
    sendError(res, error, "Failed to list workspaces");
  }
});

router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createWorkspaceInputSchema.parse(req.body ?? {});
    const workspace = await createWorkspace(req.authContext!, body);
    await activateWorkspace(req.authContext!, workspace.id);
    res.status(201).json({ workspace });
  } catch (error) {
    sendError(res, error, "Failed to create workspace");
  }
});

router.get("/:workspaceId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workspaceId } = workspaceIdSchema.parse(req.params);
    res.json({ workspace: await getWorkspace(req.authContext!, workspaceId) });
  } catch (error) {
    sendError(res, error, "Failed to read workspace");
  }
});

router.patch("/:workspaceId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workspaceId } = workspaceIdSchema.parse(req.params);
    const body = updateWorkspaceInputSchema.parse(req.body ?? {});
    res.json({ workspace: await updateWorkspace(req.authContext!, workspaceId, body) });
  } catch (error) {
    sendError(res, error, "Failed to update workspace");
  }
});

router.post("/:workspaceId/activate", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workspaceId } = workspaceIdSchema.parse(req.params);
    res.json(await activateWorkspace(req.authContext!, workspaceId));
  } catch (error) {
    sendError(res, error, "Failed to activate workspace");
  }
});

router.delete("/:workspaceId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workspaceId } = workspaceIdSchema.parse(req.params);
    await deleteWorkspace(req.authContext!, workspaceId);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, "Failed to delete workspace");
  }
});

export default router;
