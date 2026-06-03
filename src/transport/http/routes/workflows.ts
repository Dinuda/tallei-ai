import { Router, type Response } from "express";
import { z } from "zod";

import { config } from "../../../config/index.js";
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
} from "../../../services/workflow-automation/workflow-builder.service.js";
import { listWorkflowRuns } from "../../../services/workflow-automation.js";
import {
  addLoopRunComment,
  approveLoopStrategy,
  assignLoopToWorkspace,
  createLoopWorkflow,
  createWorkspace,
  dispatchDueLoopWorkflows,
  dispatchLoopHeartbeatJobs,
  approveLoopRunApprovalToken,
  approveLoopRunFromUi,
  approveLoopRunGateApprovalToken,
  executeLoopWorkflow,
  getLoopRun,
  getLoopRunRoster,
  getLoopWorkflow,
  listLoopRunComments,
  listLoopRunTasks,
  listLoopWorkflows,
  listWorkspaces,
  loopRunAgentSchema,
  rerunLoopRunTask,
  resumeLoopRunExecution,
  uploadLoopRunContacts,
  updateLoopRunRoster,
} from "../../../services/loop-executor/index.js";
import { authMiddleware, internalSecretMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

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

const taskIdSchema = z.object({
  taskId: z.string().uuid(),
});

const createLoopSchema = z.object({
  task: z.string().trim().min(1).max(4000),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  integrations: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  schedulerTarget: z.enum(["internal", "cloudflare"]).optional(),
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

const approvalTokenSchema = z.object({
  token: z.string().min(16).max(128),
});

const contactCsvSchema = z.object({
  csv: z.string().trim().min(1).max(1_000_000),
});

router.post("/internal/loops/scheduler/wake", internalSecretMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({ limit: z.number().int().min(1).max(25).optional() }).parse(req.body ?? {});
    const result = await dispatchDueLoopWorkflows({ limit: body.limit, source: "cloudflare" });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error dispatching due loop workflows:", error);
    res.status(500).json({ error: "Failed to dispatch due loop workflows" });
  }
});

router.post("/internal/loops/heartbeat/dispatch", internalSecretMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({ limit: z.number().int().min(1).max(25).optional() }).parse(req.body ?? {});
    const result = await dispatchLoopHeartbeatJobs({ limit: body.limit, source: "cloudflare" });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error dispatching loop heartbeat jobs:", error);
    res.status(500).json({ error: "Failed to dispatch loop heartbeat jobs" });
  }
});

router.get("/loops/approvals/:token", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = approvalTokenSchema.parse({ token: req.params.token });
    res.redirect(302, `${config.publicBaseUrl.replace(/\/$/, "")}/api/workflows/loops/approvals/${token}/approve`);
  } catch {
    res.status(400).json({ error: "Invalid approval token" });
  }
});

router.get("/loops/approvals/:token/approve", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = approvalTokenSchema.parse({ token: req.params.token });
    const result = await approveLoopRunGateApprovalToken(token).catch((error) => {
      if (error instanceof Error && /Invalid gate approval target/i.test(error.message)) {
        return approveLoopRunApprovalToken(token);
      }
      throw error;
    });
    const redirectUrl = `${config.frontendUrl.replace(/\/$/, "")}/dashboard/loops/${result.workflowId}/runs/${result.runId}?approved=1`;
    res.redirect(302, redirectUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval failed";
    res.status(400).json({ error: message });
  }
});

router.post("/loops/approvals/:token/approve", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = approvalTokenSchema.parse({ token: req.params.token });
    const result = await approveLoopRunGateApprovalToken(token).catch((error) => {
      if (error instanceof Error && /Invalid gate approval target/i.test(error.message)) {
        return approveLoopRunApprovalToken(token);
      }
      throw error;
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval failed";
    res.status(400).json({ error: message });
  }
});

router.use(authMiddleware);

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

router.get("/internal/loops", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const loops = await listLoopWorkflows(req.authContext!);
    res.json({ loops });
  } catch (error) {
    if (error instanceof Error && /admin/i.test(error.message)) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error("Error listing internal loop workflows:", error);
    res.status(500).json({ error: "Failed to list internal loop workflows" });
  }
});

router.post("/internal/loops", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createLoopSchema.parse(req.body ?? {});
    const loop = await createLoopWorkflow({
      auth: req.authContext!,
      task: body.task,
      cron: body.cron,
      timezone: body.timezone,
      integrations: body.integrations,
      schedulerTarget: body.schedulerTarget,
      workspaceId: body.workspaceId,
    });
    res.status(201).json({ loop });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /admin/i.test(error.message)) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error("Error creating internal loop workflow:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to create internal loop workflow" });
  }
});

router.get("/internal/loops/:workflowId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse({ workflowId: req.params.workflowId });
    const loop = await getLoopWorkflow(req.authContext!, workflowId);
    if (!loop) {
      res.status(404).json({ error: "Loop workflow not found" });
      return;
    }
    res.json({ loop });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /admin/i.test(error.message)) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error("Error reading internal loop workflow:", error);
    res.status(500).json({ error: "Failed to read internal loop workflow" });
  }
});

router.get("/internal/loops/:workflowId/runs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse({ workflowId: req.params.workflowId });
    await getLoopWorkflow(req.authContext!, workflowId);
    const runs = await listWorkflowRuns(req.authContext!, workflowId);
    res.json({ runs });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error listing loop workflow runs:", error);
    res.status(500).json({ error: "Failed to list loop workflow runs" });
  }
});

router.post("/internal/loops/:workflowId/run", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { workflowId } = workflowIdSchema.parse({ workflowId: req.params.workflowId });
    await getLoopWorkflow(req.authContext!, workflowId);
    const run = await executeLoopWorkflow({
      auth: req.authContext!,
      workflowId,
      runMode: "manual",
      scheduledFor: null,
    });
    res.status(201).json({ run });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /admin/i.test(error.message)) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error("Error running internal loop workflow:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to run internal loop workflow" });
  }
});

router.get("/workspaces", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const workspaces = await listWorkspaces(req.authContext!);
    res.json({ workspaces });
  } catch (error) {
    if (error instanceof Error && /admin/i.test(error.message)) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error("Error listing loop workspaces:", error);
    res.status(500).json({ error: "Failed to list loop workspaces" });
  }
});

router.post("/workspaces", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createWorkspaceSchema.parse(req.body ?? {});
    const workspace = await createWorkspace(req.authContext!, {
      name: body.name,
      description: body.description,
    });
    res.status(201).json({ workspace });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /admin/i.test(error.message)) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error("Error creating loop workspace:", error);
    res.status(500).json({ error: "Failed to create loop workspace" });
  }
});

router.post("/workspaces/assign-loop", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = assignWorkspaceSchema.parse(req.body ?? {});
    const result = await assignLoopToWorkspace(req.authContext!, {
      workflowId: body.workflowId,
      workspaceId: body.workspaceId,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /admin/i.test(error.message)) {
      res.status(403).json({ error: error.message });
      return;
    }
    console.error("Error assigning loop workspace:", error);
    res.status(500).json({ error: "Failed to assign loop workspace" });
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
    const run = await approveLoopRunFromUi({
      auth: req.authContext!,
      runId,
    }).catch(async (error) => {
      if (error instanceof Error && /no loop approval context|not waiting for approval/i.test(error.message)) {
        return approveRunById({
          auth: req.authContext!,
          runId,
        });
      }
      throw error;
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

router.post("/runs/:runId/contacts", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const body = contactCsvSchema.parse(req.body ?? {});
    const result = await uploadLoopRunContacts({
      auth: req.authContext!,
      runId,
      csv: body.csv,
    });
    res.status(202).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not waiting|contact list|No contacts|CSV/i.test(error.message)) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error uploading loop contacts:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to upload contacts" });
  }
});

router.post("/runs/:runId/approve-strategy", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const body = z.object({
      roster: z.array(loopRunAgentSchema).optional(),
    }).parse(req.body ?? {});
    const run = await approveLoopStrategy({
      auth: req.authContext!,
      runId,
      roster: body.roster,
    });
    res.status(202).json({ run });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /not waiting_for_strategy_approval/i.test(error.message)) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error approving loop strategy:", error);
    res.status(500).json({ error: "Failed to approve loop strategy" });
  }
});

router.post("/runs/:runId/resume", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const result = await resumeLoopRunExecution({
      auth: req.authContext!,
      runId,
    });
    res.status(202).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /cannot resume/i.test(error.message)) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error resuming loop run:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to resume loop run" });
  }
});

router.post("/runs/:runId/tasks/:taskId/rerun", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const { taskId } = taskIdSchema.parse({ taskId: req.params.taskId });
    const result = await rerunLoopRunTask({
      auth: req.authContext!,
      runId,
      taskId,
    });
    res.status(202).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /already running/i.test(error.message)) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error rerunning loop task:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to rerun loop task" });
  }
});

router.get("/runs/:runId/roster", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const roster = await getLoopRunRoster(req.authContext!, runId);
    res.json({ roster });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error reading loop run roster:", error);
    res.status(500).json({ error: "Failed to read loop run roster" });
  }
});

router.put("/runs/:runId/roster", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const body = z.object({
      roster: z.array(loopRunAgentSchema).min(1).max(6),
    }).parse(req.body ?? {});
    const result = await updateLoopRunRoster(req.authContext!, { runId, roster: body.roster });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /not editable/i.test(error.message)) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error updating loop run roster:", error);
    res.status(500).json({ error: "Failed to update loop run roster" });
  }
});

router.get("/runs/:runId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const run = await getLoopRun(req.authContext!, runId);
    res.json({ run });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error reading loop run:", error);
    res.status(500).json({ error: "Failed to read loop run" });
  }
});

router.get("/runs/:runId/tasks", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const tasks = await listLoopRunTasks(req.authContext!, runId);
    res.json({ tasks });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error listing loop run tasks:", error);
    res.status(500).json({ error: "Failed to list loop run tasks" });
  }
});

router.get("/runs/:runId/comments", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const comments = await listLoopRunComments(req.authContext!, runId);
    res.json({ comments });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error listing loop run comments:", error);
    res.status(500).json({ error: "Failed to list loop run comments" });
  }
});

const runCommentSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  taskId: z.string().uuid().nullable().optional(),
});

router.post("/runs/:runId/comments", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const body = runCommentSchema.parse(req.body ?? {});
    const comment = await addLoopRunComment(req.authContext!, {
      runId,
      body: body.body,
      taskId: body.taskId,
    });
    res.status(201).json({ comment });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error adding loop run comment:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to add loop run comment" });
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
