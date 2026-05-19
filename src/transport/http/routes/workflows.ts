import { Router, type Response } from "express";
import { z } from "zod";

import {
  appendWorkflowBuilderMessage,
  approveRunById,
  createWorkflowBuilderSession,
  getWorkflowBuilderSession,
  listWorkflowBuilderSessions,
  listWorkflowsWithRuns,
  runWorkflowNow,
  saveWorkflowFromBuilderSession,
  setWorkflowStatus,
  skipRunById,
} from "../../../services/workflow-builder.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  goal: z.string().trim().min(1).max(1000),
});

const messageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

const workflowIdSchema = z.object({
  workflowId: z.string().uuid(),
});

const runIdSchema = z.object({
  runId: z.string().uuid(),
});

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const [workflows, sessions] = await Promise.all([
      listWorkflowsWithRuns(req.authContext!),
      listWorkflowBuilderSessions(req.authContext!),
    ]);
    res.json({ workflows, builderSessions: sessions });
  } catch (error) {
    console.error("Error listing workflows:", error);
    res.status(500).json({ error: "Failed to list workflows" });
  }
});

router.post("/builder/sessions", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createSessionSchema.parse(req.body ?? {});
    const session = await createWorkflowBuilderSession({
      auth: req.authContext!,
      title: body.title,
      goal: body.goal,
    });
    res.status(201).json({ session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error creating workflow builder session:", error);
    res.status(500).json({ error: "Failed to create workflow builder session" });
  }
});

router.get("/builder/sessions/:id", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const session = await getWorkflowBuilderSession(req.authContext!, String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Workflow builder session not found" });
      return;
    }
    res.json({ session });
  } catch (error) {
    console.error("Error reading workflow builder session:", error);
    res.status(500).json({ error: "Failed to read workflow builder session" });
  }
});

router.post("/builder/sessions/:id/messages", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = messageSchema.parse(req.body ?? {});
    const session = await appendWorkflowBuilderMessage({
      auth: req.authContext!,
      sessionId: String(req.params.id),
      message: body.message,
    });
    const lastAssistant = [...session.transcript].reverse().find((entry) => entry.actor === "assistant");
    res.json({
      session,
      message: lastAssistant?.content ?? "Draft updated.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found|archived/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error appending workflow builder message:", error);
    res.status(500).json({ error: "Failed to append workflow builder message" });
  }
});

router.post("/builder/sessions/:id/save", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const result = await saveWorkflowFromBuilderSession({
      auth: req.authContext!,
      sessionId: String(req.params.id),
    });
    res.json(result);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error saving workflow builder session:", error);
    res.status(500).json({ error: "Failed to save workflow builder session" });
  }
});

router.post("/:workflowId/run", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse({ workflowId: req.params.workflowId });
    const run = await runWorkflowNow({
      auth: req.authContext!,
      workflowId,
    });
    res.status(201).json({ run });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error starting workflow run:", error);
    res.status(500).json({ error: "Failed to start workflow run" });
  }
});

router.post("/runs/:runId/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const run = await approveRunById({
      auth: req.authContext!,
      runId,
    });
    res.json({ run });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error approving workflow run:", error);
    res.status(500).json({ error: "Failed to approve workflow run" });
  }
});

router.post("/runs/:runId/skip", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const run = await skipRunById({
      auth: req.authContext!,
      runId,
    });
    res.json({ run });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error skipping workflow run:", error);
    res.status(500).json({ error: "Failed to skip workflow run" });
  }
});

router.post("/:workflowId/pause", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse({ workflowId: req.params.workflowId });
    await setWorkflowStatus({
      auth: req.authContext!,
      workflowId,
      status: "paused",
    });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error pausing workflow:", error);
    res.status(500).json({ error: "Failed to pause workflow" });
  }
});

router.post("/:workflowId/resume", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse({ workflowId: req.params.workflowId });
    await setWorkflowStatus({
      auth: req.authContext!,
      workflowId,
      status: "active",
    });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error resuming workflow:", error);
    res.status(500).json({ error: "Failed to resume workflow" });
  }
});

router.post("/:workflowId/archive", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse({ workflowId: req.params.workflowId });
    await setWorkflowStatus({
      auth: req.authContext!,
      workflowId,
      status: "archived",
    });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error archiving workflow:", error);
    res.status(500).json({ error: "Failed to archive workflow" });
  }
});

export default router;

