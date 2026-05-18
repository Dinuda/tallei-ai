import { Router, type Response } from "express";
import { z } from "zod";

import {
  approveWorkflowRun,
  approveWorkflowSuggestion,
  createExplicitWorkflow,
  createWorkflowRun,
  dismissWorkflowSuggestion,
  getWorkflowRun,
  listActiveWorkflows,
  listWorkflowRuns,
  listWorkflowRunSteps,
  listWorkflowSuggestions,
  skipWorkflowRun,
  updateWorkflowSuggestion,
} from "../../../services/workflow-automation.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

const createWorkflowSchema = z.object({
  title: z.string().min(1),
  instruction: z.string().min(1),
  schedule_rrule: z.string().min(1),
  requires_connector: z.boolean().optional().default(false),
  connector_provider: z.string().optional(),
  connector_scope_keys: z.array(z.string()).optional().default([]),
});

const createRunSchema = z.object({
  run_mode: z.enum(["scheduled", "manual"]).optional().default("manual"),
  scheduled_for: z.string().optional().nullable(),
});

const approveSuggestionSchema = z.object({
  schedule_rrule: z.string().optional(),
  requires_connector: z.boolean().optional().default(false),
  connector_provider: z.string().optional(),
  connector_scope_keys: z.array(z.string()).optional().default([]),
});

const updateSuggestionSchema = z.object({
  title: z.string().min(1).optional(),
  suggested_prompt: z.string().min(1).optional(),
});

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const suggestions = await listWorkflowSuggestions(req.authContext!);
    res.json({ suggestions });
  } catch (error) {
    console.error("Error listing workflow suggestions:", error);
    res.status(500).json({ error: "Failed to list workflows" });
  }
});

router.get("/active", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const workflows = await listActiveWorkflows(req.authContext!);
    res.json({ workflows });
  } catch (error) {
    console.error("Error listing active workflows:", error);
    res.status(500).json({ error: "Failed to list active workflows" });
  }
});

router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createWorkflowSchema.parse(req.body ?? {});
    const created = await createExplicitWorkflow({
      auth: req.authContext!,
      title: body.title,
      instruction: body.instruction,
      scheduleRrule: body.schedule_rrule,
      requiresConnector: body.requires_connector,
      connectorProvider: body.connector_provider,
      connectorScopeKeys: body.connector_scope_keys,
    });
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /Composio is required/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error creating workflow:", error);
    res.status(500).json({ error: "Failed to create workflow" });
  }
});

router.post("/suggestions/:id/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = approveSuggestionSchema.parse(req.body ?? {});
    const result = await approveWorkflowSuggestion({
      auth: req.authContext!,
      suggestionId: String(req.params.id),
      scheduleRrule: body.schedule_rrule,
      requiresConnector: body.requires_connector,
      connectorProvider: body.connector_provider,
      connectorScopeKeys: body.connector_scope_keys,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found|not pending/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /Composio is required/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error approving workflow suggestion:", error);
    res.status(500).json({ error: "Failed to approve workflow suggestion" });
  }
});

router.post("/suggestions/:id/dismiss", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    await dismissWorkflowSuggestion({
      auth: req.authContext!,
      suggestionId: String(req.params.id),
      reason: typeof req.body?.reason === "string" ? req.body.reason : "dismissed_from_portal",
    });
    res.json({ dismissed: true });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error dismissing workflow suggestion:", error);
    res.status(500).json({ error: "Failed to dismiss workflow suggestion" });
  }
});

router.post("/suggestions/:id/update", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = updateSuggestionSchema.parse(req.body ?? {});
    await updateWorkflowSuggestion({
      auth: req.authContext!,
      suggestionId: String(req.params.id),
      title: body.title,
      suggestedPrompt: body.suggested_prompt,
    });
    res.json({ updated: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error updating workflow suggestion:", error);
    res.status(500).json({ error: "Failed to update workflow suggestion" });
  }
});

router.post("/:id/runs", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createRunSchema.parse(req.body ?? {});
    const run = await createWorkflowRun({
      auth: req.authContext!,
      workflowId: String(req.params.id),
      runMode: body.run_mode,
      scheduledFor: body.scheduled_for ?? null,
    });
    res.status(201).json(run);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error creating workflow run:", error);
    res.status(500).json({ error: "Failed to create workflow run" });
  }
});

router.get("/:id/runs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const runs = await listWorkflowRuns(req.authContext!, String(req.params.id));
    res.json({ runs });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error listing workflow runs:", error);
    res.status(500).json({ error: "Failed to list workflow runs" });
  }
});

router.get("/:id/runs/:runId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const includeSdk = req.query.include_sdk === "true";
    const run = await getWorkflowRun(
      req.authContext!,
      String(req.params.id),
      String(req.params.runId),
      { includeSdkDetails: includeSdk }
    );
    res.json(run);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error getting workflow run:", error);
    res.status(500).json({ error: "Failed to get workflow run" });
  }
});

router.post("/:id/runs/:runId/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const run = await approveWorkflowRun({
      auth: req.authContext!,
      workflowId: String(req.params.id),
      runId: String(req.params.runId),
      channel: "portal",
    });
    res.json(run);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /waiting for approval|Missing connected Composio/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("Error approving workflow run:", error);
    res.status(500).json({ error: "Failed to approve workflow run" });
  }
});

router.post("/:id/runs/:runId/skip", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const run = await skipWorkflowRun({
      auth: req.authContext!,
      workflowId: String(req.params.id),
      runId: String(req.params.runId),
      channel: "portal",
    });
    res.json(run);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error skipping workflow run:", error);
    res.status(500).json({ error: "Failed to skip workflow run" });
  }
});

router.get("/:id/runs/:runId/steps", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const steps = await listWorkflowRunSteps(req.authContext!, String(req.params.id), String(req.params.runId));
    res.json({ steps });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error listing workflow run steps:", error);
    res.status(500).json({ error: "Failed to list workflow run steps" });
  }
});

router.get("/:id/runs/:runId/health", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const run = await getWorkflowRun(
      req.authContext!,
      String(req.params.id),
      String(req.params.runId),
      { includeSdkDetails: true }
    );
    const steps = await listWorkflowRunSteps(req.authContext!, String(req.params.id), String(req.params.runId));
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
    const sdkRunRecord = run.sdkRun?.run as { status?: unknown } | undefined;
    const sdkEventCount = Array.isArray(run.sdkRun?.events) ? run.sdkRun!.events.length : 0;

    res.json({
      run,
      sdk: {
        enabled: Boolean(run.sdkRunId),
        runId: run.sdkRunId ?? null,
        status: typeof sdkRunRecord?.status === "string" ? sdkRunRecord.status : null,
        eventCount: sdkEventCount,
      },
      lastStep,
    });
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error getting workflow run health:", error);
    res.status(500).json({ error: "Failed to get workflow run health" });
  }
});

export default router;
