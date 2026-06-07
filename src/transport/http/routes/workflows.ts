import { Router, type Response } from "express";
import { z } from "zod";

import {
  assignLoopToWorkspace,
  createLoopWorkflow,
  createWorkspace,
  deleteLoopWorkflow,
  getLoopWorkflow,
  listLoopWorkflows,
  listWorkspaces,
  loopDefinitionSchema,
} from "../../../services/loop-executor/index.js";
import {
  cancelLoopRuntimeRun,
  decideLoopRuntimeGate,
  getLoopRuntimeProjection,
  listLoopRuntimeRuns,
  retryLoopRuntimeStep,
  startManualLoopRun,
} from "../../../services/loop-runtime/index.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

const workflowIdSchema = z.object({ workflowId: z.string().uuid() });
const runIdSchema = z.object({ runId: z.string().uuid() });
const gateIdSchema = z.object({ gateId: z.string().uuid() });
const stepIdSchema = z.object({ stepId: z.string().uuid() });

const createLoopSchema = z.object({
  definition: loopDefinitionSchema,
  title: z.string().trim().min(1).max(160).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
});

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

const assignWorkspaceSchema = z.object({
  workflowId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
});

const gateInputSchema = z.object({ value: z.string().min(1).max(1_000_000) });
const gateRejectSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.errors });
    return;
  }
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message) ? 404 : /only loop_engine_v3|disabled|requires/i.test(message) ? 409 : 500;
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

async function createLoop(req: AuthRequest, res: Response) {
  try {
    const body = createLoopSchema.parse(req.body ?? {});
    const loop = await createLoopWorkflow({
      auth: req.authContext!,
      definition: body.definition,
      title: body.title,
      workspaceId: body.workspaceId,
    });
    res.status(201).json({ loop });
  } catch (error) {
    sendError(res, error, "Failed to create loop");
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
    await getLoopWorkflow(req.authContext!, workflowId);
    const runs = await listLoopRuntimeRuns(req.authContext!, workflowId);
    res.json({ runs });
  } catch (error) {
    sendError(res, error, "Failed to list runs");
  }
}

async function startRun(req: AuthRequest, res: Response) {
  try {
    const { workflowId } = workflowIdSchema.parse(req.params);
    const run = await startManualLoopRun(req.authContext!, workflowId);
    res.status(201).json({ run });
  } catch (error) {
    sendError(res, error, "Failed to start run");
  }
}

router.get("/", requireScopes(["memory:read"]), listLoops);
router.get("/loops", requireScopes(["memory:read"]), listLoops);
router.post("/loops", requireScopes(["memory:write"]), createLoop);
router.get("/loops/:workflowId", requireScopes(["memory:read"]), getLoop);
router.delete("/loops/:workflowId", requireScopes(["memory:write"]), deleteLoop);
router.get("/loops/:workflowId/runs", requireScopes(["memory:read"]), listRuns);
router.post("/loops/:workflowId/runs", requireScopes(["memory:write"]), startRun);

router.get("/internal/loops", requireScopes(["memory:read"]), listLoops);
router.post("/internal/loops", requireScopes(["memory:write"]), createLoop);
router.get("/internal/loops/:workflowId", requireScopes(["memory:read"]), getLoop);
router.delete("/internal/loops/:workflowId", requireScopes(["memory:write"]), deleteLoop);
router.get("/internal/loops/:workflowId/runs", requireScopes(["memory:read"]), listRuns);
router.post("/internal/loops/:workflowId/runs", requireScopes(["memory:write"]), startRun);

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
    res.json({ run: await getLoopRuntimeProjection(req.authContext!, runId) });
  } catch (error) {
    sendError(res, error, "Failed to read run");
  }
});

router.post("/runs/:runId/cancel", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    res.json({ run: await cancelLoopRuntimeRun(req.authContext!, runId) });
  } catch (error) {
    sendError(res, error, "Failed to cancel run");
  }
});

router.post("/runs/:runId/steps/:stepId/retry", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    const { stepId } = stepIdSchema.parse(req.params);
    res.status(202).json({ run: await retryLoopRuntimeStep(req.authContext!, runId, stepId) });
  } catch (error) {
    sendError(res, error, "Failed to retry step");
  }
});

router.post("/runs/:runId/gates/:gateId/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    const { gateId } = gateIdSchema.parse(req.params);
    const value = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    res.json(await decideLoopRuntimeGate({ auth: req.authContext!, runId, gateId, decision: "approve", value }));
  } catch (error) {
    sendError(res, error, "Failed to approve gate");
  }
});

router.post("/runs/:runId/gates/:gateId/input", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    const { gateId } = gateIdSchema.parse(req.params);
    const value = gateInputSchema.parse(req.body ?? {});
    res.json(await decideLoopRuntimeGate({ auth: req.authContext!, runId, gateId, decision: "input", value }));
  } catch (error) {
    sendError(res, error, "Failed to submit gate input");
  }
});

router.post("/runs/:runId/gates/:gateId/reject", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse(req.params);
    const { gateId } = gateIdSchema.parse(req.params);
    const value = gateRejectSchema.parse(req.body ?? {});
    res.json(await decideLoopRuntimeGate({ auth: req.authContext!, runId, gateId, decision: "reject", value }));
  } catch (error) {
    sendError(res, error, "Failed to reject gate");
  }
});

export default router;
