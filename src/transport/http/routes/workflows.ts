import { Router, type Response } from "express";
import { z } from "zod";

import {
  assignLoopToWorkspace,
  createWorkspace,
  deleteLoopWorkflow,
  getLoopWorkflow,
  getWorkflowVerification,
  listLoopWorkflows,
  listWorkspaces,
  runWorkflowVerification,
  confirmWorkflowVerification,
} from "../../../services/loop-executor/index.js";
import {
  cancelSpecLoopRun,
  getSpecRunEditorialProjection,
  getWorkflowTriggerActivity,
  listSpecLoopRuns,
  retrySpecLoopRun,
  saveSpecRunAsLoop,
  saveCanvasEmailArtifact,
  startSpecManualLoopRun,
} from "../../../services/loop-runtime/index.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();
router.use(authMiddleware);
router.use(workspaceMiddleware);

const workflowIdSchema = z.object({ workflowId: z.string().uuid() });
const runIdSchema = z.object({ runId: z.string().uuid() });
const artifactKeySchema = z.object({ artifactKey: z.string().trim().min(1).max(240) });
const canvasEmailSaveSchema = z.object({
  design: z.unknown().optional(),
  html: z.string().min(1).max(5_000_000),
  text: z.string().max(1_000_000).optional(),
  subject: z.string().max(500).optional(),
  preview: z.string().max(1_000).optional(),
  reactEmailSource: z.string().max(1_000_000).optional(),
  editorContent: z.string().max(5_000_000).optional(),
  designId: z.string().max(120).optional(),
  source: z.string().max(120).optional(),
  updatedAt: z.string().max(120).optional(),
  finalUse: z.boolean().optional(),
});
const saveRunAsLoopSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  definition: z.unknown().optional(),
});

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

const assignWorkspaceSchema = z.object({
  workflowId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
});

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.errors });
    return;
  }
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message) ? 404 : /legacy graph|disabled|requires/i.test(message) ? 409 : 500;
  res.status(status).json({ error: message });
}

async function listLoops(req: AuthRequest, res: Response) {
  try {
    const loops = await listLoopWorkflows(req.authContext!);
    res.json({ loops, workflows: loops, builderSessions: [] });
  } catch (error) {
    sendError(res, error, "Failed to list loops");
  }
}

async function getLoop(req: AuthRequest, res: Response) {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    const loop = await getLoopWorkflow(req.authContext!, workflowId);
    if (!loop) {
      res.status(404).json({ error: "Loop workflow not found" });
      return;
    }
    res.json({ loop });
  } catch (error) {
    sendError(res, error, "Failed to read loop");
  }
}

async function deleteLoop(req: AuthRequest, res: Response) {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    await deleteLoopWorkflow(req.authContext!, workflowId);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error, "Failed to archive loop");
  }
}

async function listRuns(req: AuthRequest, res: Response) {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    const loop = await getLoopWorkflow(req.authContext!, workflowId);
    if (!loop) {
      res.status(404).json({ error: "Loop workflow not found" });
      return;
    }
    const runs = await listSpecLoopRuns(req.authContext!, workflowId);
    res.json({ runs });
  } catch (error) {
    sendError(res, error, "Failed to list runs");
  }
}

async function startRun(req: AuthRequest, res: Response) {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    const run = await startSpecManualLoopRun(req.authContext!, workflowId);
    res.status(201).json({ run });
  } catch (error) {
    sendError(res, error, "Failed to start run");
  }
}

router.get("/", requireScopes(["memory:read"]), listLoops);
router.get("/loops", requireScopes(["memory:read"]), listLoops);
router.get("/loops/:workflowId", requireScopes(["memory:read"]), getLoop);
router.delete("/loops/:workflowId", requireScopes(["memory:write"]), deleteLoop);
router.get("/loops/:workflowId/runs", requireScopes(["memory:read"]), listRuns);
router.post("/loops/:workflowId/runs", requireScopes(["memory:write"]), startRun);
router.get("/loops/:workflowId/verification", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    res.json({ verification: await getWorkflowVerification(req.authContext!, workflowId) });
  } catch (error) {
    sendError(res, error, "Failed to read workflow verification");
  }
});
router.post("/loops/:workflowId/verification/run", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    res.json({ verification: await runWorkflowVerification(req.authContext!, workflowId) });
  } catch (error) {
    sendError(res, error, "Failed to run workflow verification");
  }
});
router.post("/loops/:workflowId/verification/confirm", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    res.json({ verification: await confirmWorkflowVerification(req.authContext!, workflowId) });
  } catch (error) {
    sendError(res, error, "Failed to confirm workflow verification");
  }
});

router.get("/internal/loops", requireScopes(["memory:read"]), listLoops);
router.get("/internal/loops/:workflowId", requireScopes(["memory:read"]), getLoop);
router.delete("/internal/loops/:workflowId", requireScopes(["memory:write"]), deleteLoop);
router.get("/internal/loops/:workflowId/runs", requireScopes(["memory:read"]), listRuns);
router.post("/internal/loops/:workflowId/runs", requireScopes(["memory:write"]), startRun);
router.get("/internal/loops/:workflowId/triggers", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    res.json({ triggers: await getWorkflowTriggerActivity(req.authContext!, workflowId) });
  } catch (error) {
    sendError(res, error, "Failed to read workflow triggers");
  }
});

router.get("/workspaces", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ workspaces: await listWorkspaces(req.authContext!) });
  } catch (error) {
    sendError(res, error, "Failed to list workspaces");
  }
});

router.post("/workspaces", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createWorkspaceSchema.parse(req.body ?? {});
    const workspace = await createWorkspace(req.authContext!, body);
    res.status(201).json({ workspace });
  } catch (error) {
    sendError(res, error, "Failed to create workspace");
  }
});

router.post("/workspaces/assign-loop", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = assignWorkspaceSchema.parse(req.body ?? {});
    res.json(await assignLoopToWorkspace(req.authContext!, body));
  } catch (error) {
    sendError(res, error, "Failed to assign workspace");
  }
});

router.get("/runs/:runId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    res.json({ run: await getSpecRunEditorialProjection(req.authContext!, runId) });
  } catch (error) {
    sendError(res, error, "Failed to read run");
  }
});

router.get("/runs/:runId/messages", requireScopes(["memory:read"]), async (_req: AuthRequest, res: Response) => {
  res.status(410).json({ error: "Run chat has been removed and is being rebuilt." });
});

router.post("/loops/:workflowId/run/chat", requireScopes(["memory:write"]), async (_req: AuthRequest, res: Response) => {
  res.status(410).json({ error: "Run chat has been removed and is being rebuilt." });
});

router.post("/runs/:runId/cancel", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    res.json({ run: await cancelSpecLoopRun(req.authContext!, runId) });
  } catch (error) {
    sendError(res, error, "Failed to cancel run");
  }
});

router.post("/runs/:runId/retry", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    await retrySpecLoopRun(req.authContext!, runId);
    res.status(202).json({ run: await getSpecRunEditorialProjection(req.authContext!, runId) });
  } catch (error) {
    sendError(res, error, "Failed to retry run");
  }
});

router.post("/runs/:runId/save-as-loop", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    const body = saveRunAsLoopSchema.parse(req.body ?? {});
    res.status(201).json(await saveSpecRunAsLoop({
      auth: req.authContext!,
      runId,
      title: body.title,
      definition: body.definition,
    }));
  } catch (error) {
    sendError(res, error, "Failed to save run as loop");
  }
});

router.post("/runs/:runId/artifacts/:artifactKey/canvas/email", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    const { artifactKey } = artifactKeySchema.parse(req.params);
    const body = canvasEmailSaveSchema.parse(req.body ?? {});
    res.status(201).json({
      run: await saveCanvasEmailArtifact({
        auth: req.authContext!,
        runId,
        artifactKey,
        emailTemplate: body,
      }),
    });
  } catch (error) {
    sendError(res, error, "Failed to save canvas email");
  }
});

router.post("/runs/:runId/interactions/:interactionId/commands", requireScopes(["memory:write"]), async (_req: AuthRequest, res: Response) => {
  res.status(410).json({ error: "Run interactions have been removed and are being rebuilt." });
});

export default router;
