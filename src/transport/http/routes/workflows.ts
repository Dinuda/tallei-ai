import { Router, type Response } from "express";
import { z } from "zod";

import { config } from "../../../config/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import {
  consumeWorkflowApprovalToken,
  resolveWorkflowApprovalToken,
} from "../../../services/approval-tokens.js";
import { formatNewsletterForEmail, normalizeNewsletterTemplateId } from "../../../services/loop-executor/presets/newsletter.js";
import { renderNewsletterReactEmail } from "../../../services/loop-executor/presets/newsletter-react-email.js";
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
  loopAgentGraphSchema,
  loopPlanSchema,
  loopRunAgentSchema,
  rejectLoopRunGate,
  rerunLoopRunTask,
  resumeLoopRunExecution,
  uploadLoopRunContacts,
  updateLoopRunNewsletterDraft,
  updateLoopRunRoster,
} from "../../../services/loop-executor/index.js";
import { authMiddleware, internalSecretMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

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
  allowed_tool_refs: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  agent_graph: loopAgentGraphSchema.optional(),
  plan: loopPlanSchema.optional(),
  schedulerTarget: z.enum(["internal", "cloudflare"]).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  preset_id: z.string().trim().min(1).max(80).optional(),
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
  templateId: z.string().trim().min(1).max(80).optional(),
});

const newsletterDraftSchema = z.object({
  body: z.string().trim().min(1).max(200_000),
});

const newsletterPreviewSchema = z.object({
  body: z.string().trim().min(1).max(200_000),
  templateId: z.string().trim().min(1).max(80).optional(),
});

async function applyWorkflowApprovalTokenDecision(token: string, decision: "approve" | "skip") {
  const resolved = await resolveWorkflowApprovalToken(token);
  if (!resolved) {
    throw new Error("Approval token not found");
  }
  if (resolved.expired) {
    throw new Error("Approval token expired");
  }
  if (resolved.consumedAt) {
    throw new Error("Approval token already used");
  }

  const auth = {
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    authMode: "internal" as const,
    plan: "pro" as const,
  };

  if (resolved.targetType === "workflow_gate") {
    if (decision === "approve") {
      return approveLoopRunGateApprovalToken(token);
    }
    const gate = await pool.query<{ workflow_run_id: string; workflow_id: string }>(
      `SELECT g.workflow_run_id, r.workflow_id
       FROM loop_run_gates g
       JOIN workflow_runs r ON r.id = g.workflow_run_id
       WHERE g.id = $1
         AND g.tenant_id = $2
         AND g.user_id = $3
       LIMIT 1`,
      [resolved.targetId, resolved.tenantId, resolved.userId]
    );
    const row = gate.rows[0];
    if (!row) {
      throw new Error("Loop gate not found");
    }
    await rejectLoopRunGate({
      auth,
      runId: row.workflow_run_id,
      gateId: resolved.targetId,
      reason: "approval_token_skip",
    });
    await consumeWorkflowApprovalToken(token);
    return { runId: row.workflow_run_id, workflowId: row.workflow_id, status: "blocked", gateId: resolved.targetId };
  }

  if (resolved.targetType === "workflow_run") {
    if (decision === "approve") {
      const result = await approveLoopRunApprovalToken(token);
      return { kind: "workflow_run" as const, ...result };
    }
    throw new Error("Loop run approval tokens can only be approved");
  }

  throw new Error("Unsupported approval target");
}

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

router.get("/approvals/:token", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = approvalTokenSchema.parse({ token: req.params.token });
    res.redirect(302, `${config.publicBaseUrl.replace(/\/$/, "")}/api/workflows/approvals/${token}/approve`);
  } catch {
    res.status(400).json({ error: "Invalid approval token" });
  }
});

router.get("/approvals/:token/approve", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = approvalTokenSchema.parse({ token: req.params.token });
    const result = await applyWorkflowApprovalTokenDecision(token, "approve");
    res.redirect(302, `${config.frontendUrl.replace(/\/$/, "")}/dashboard/loops/${result.workflowId}/runs/${result.runId}?approved=1`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval failed";
    res.status(400).json({ error: message });
  }
});

router.post("/approvals/:token/approve", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = approvalTokenSchema.parse({ token: req.params.token });
    const result = await applyWorkflowApprovalTokenDecision(token, "approve");
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval failed";
    res.status(400).json({ error: message });
  }
});

router.post("/approvals/:token/skip", async (req: AuthRequest, res: Response) => {
  try {
    const { token } = approvalTokenSchema.parse({ token: req.params.token });
    const result = await applyWorkflowApprovalTokenDecision(token, "skip");
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Skip failed";
    res.status(400).json({ error: message });
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
    const workflows = await listLoopWorkflows(req.authContext!);
    res.json({ workflows, builderSessions: [] });
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
      allowedToolRefs: body.allowed_tool_refs,
      agentGraph: body.agent_graph,
      plan: body.plan,
      schedulerTarget: body.schedulerTarget,
      workspaceId: body.workspaceId,
      presetId: body.preset_id,
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
    const result = await pool.query(
      `SELECT id, workflow_id, status, run_mode, scheduled_for, created_at, updated_at
       FROM workflow_runs
       WHERE workflow_id = $1
         AND tenant_id = $2
         AND user_id = $3
       ORDER BY created_at DESC
       LIMIT 100`,
      [workflowId, req.authContext!.tenantId, req.authContext!.userId]
    );
    const runs = result.rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status,
      runMode: row.run_mode,
      scheduledFor: row.scheduled_for,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
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

router.post("/runs/:runId/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const run = await approveLoopRunFromUi({
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

router.post("/runs/:runId/contacts", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const body = contactCsvSchema.parse(req.body ?? {});
    const result = await uploadLoopRunContacts({
      auth: req.authContext!,
      runId,
      csv: body.csv,
      templateId: body.templateId,
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

router.patch("/runs/:runId/newsletter", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    const body = newsletterDraftSchema.parse(req.body ?? {});
    const run = await updateLoopRunNewsletterDraft(req.authContext!, { runId, body: body.body });
    res.json({ run });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /executing|body is required/i.test(error.message)) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error updating newsletter draft:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update newsletter draft" });
  }
});

router.post("/runs/:runId/newsletter/preview", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { runId } = runIdSchema.parse({ runId: req.params.runId });
    await getLoopRun(req.authContext!, runId);
    const body = newsletterPreviewSchema.parse(req.body ?? {});
    const formatted = formatNewsletterForEmail(body.body);
    const templateId = normalizeNewsletterTemplateId(body.templateId);
    const html = await renderNewsletterReactEmail({
      templateId,
      subject: formatted.subject,
      markdown: formatted.text,
    });
    res.json({ html, subject: formatted.subject, body: formatted.text, templateId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error rendering newsletter preview:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to render newsletter preview" });
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

export default router;
