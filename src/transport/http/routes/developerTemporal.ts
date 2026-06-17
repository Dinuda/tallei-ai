import { Router } from "express";

import { pool } from "../../../infrastructure/db/index.js";
import { authMiddleware, requireScopes, type AuthRequest } from "../middleware/auth.middleware.js";
import { getTemporalClient, isTemporalEnabled } from "../../../temporal/client.js";
import {
  parseLoopRunWorkflowId,
  parseLoopScheduleId,
  tenantLoopRunSearchQuery,
  tenantLoopScheduleSearchQuery,
} from "../../../temporal/ids.js";
import { pauseLoopSchedule, unpauseLoopSchedule } from "../../../temporal/schedules.js";

const router = Router();
router.use(authMiddleware);

function temporalUnavailable(res: import("express").Response) {
  res.status(503).json({ error: "Temporal is not enabled on this deployment." });
}

async function loadWorkflowTitles(
  tenantId: string,
  userId: string,
  workflowIds: string[],
): Promise<Map<string, string>> {
  if (workflowIds.length === 0) return new Map();
  const result = await pool.query<{ id: string; title: string }>(
    `SELECT id, title
     FROM workflows
     WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])`,
    [tenantId, userId, workflowIds],
  );
  return new Map(result.rows.map((row) => [row.id, row.title]));
}

router.get("/workflows/running", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  if (!isTemporalEnabled()) return temporalUnavailable(res);
  try {
    const auth = req.authContext!;
    const client = await getTemporalClient();
    const prefix = tenantLoopRunSearchQuery(auth.tenantId);
    const query = `WorkflowId STARTS_WITH "${prefix}" AND ExecutionStatus = "Running"`;
    const items: Array<{
      temporalWorkflowId: string;
      workflowId: string;
      runId: string;
      workflowTitle: string;
      status: string;
      startTime: string | null;
    }> = [];
    const workflowIds = new Set<string>();

    for await (const execution of client.workflow.list({ query })) {
      const parsed = parseLoopRunWorkflowId(execution.workflowId);
      if (!parsed || parsed.tenantId !== auth.tenantId) continue;
      workflowIds.add(parsed.workflowId);
      items.push({
        temporalWorkflowId: execution.workflowId,
        workflowId: parsed.workflowId,
        runId: parsed.runId,
        workflowTitle: "",
        status: execution.status.name,
        startTime: execution.startTime?.toISOString() ?? null,
      });
    }

    const titles = await loadWorkflowTitles(auth.tenantId, auth.userId, [...workflowIds]);
    res.json({
      workflows: items.map((item) => ({
        ...item,
        workflowTitle: titles.get(item.workflowId) ?? "Loop",
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list running workflows" });
  }
});

router.get("/workflows/history", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  if (!isTemporalEnabled()) return temporalUnavailable(res);
  try {
    const auth = req.authContext!;
    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    const client = await getTemporalClient();
    const prefix = tenantLoopRunSearchQuery(auth.tenantId);
    const query = `WorkflowId STARTS_WITH "${prefix}" AND CloseTime IS NOT NULL`;
    const items: Array<{
      temporalWorkflowId: string;
      workflowId: string;
      runId: string;
      workflowTitle: string;
      status: string;
      startTime: string | null;
      closeTime: string | null;
    }> = [];
    const workflowIds = new Set<string>();

    for await (const execution of client.workflow.list({ query })) {
      if (items.length >= limit) break;
      const parsed = parseLoopRunWorkflowId(execution.workflowId);
      if (!parsed || parsed.tenantId !== auth.tenantId) continue;
      workflowIds.add(parsed.workflowId);
      items.push({
        temporalWorkflowId: execution.workflowId,
        workflowId: parsed.workflowId,
        runId: parsed.runId,
        workflowTitle: "",
        status: execution.status.name,
        startTime: execution.startTime?.toISOString() ?? null,
        closeTime: execution.closeTime?.toISOString() ?? null,
      });
    }

    const titles = await loadWorkflowTitles(auth.tenantId, auth.userId, [...workflowIds]);
    res.json({
      workflows: items.map((item) => ({
        ...item,
        workflowTitle: titles.get(item.workflowId) ?? "Loop",
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list workflow history" });
  }
});

router.get("/schedules", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  if (!isTemporalEnabled()) return temporalUnavailable(res);
  try {
    const auth = req.authContext!;
    const client = await getTemporalClient();
    const prefix = tenantLoopScheduleSearchQuery(auth.tenantId);
    const schedules: Array<{
      scheduleId: string;
      workflowId: string;
      workflowTitle: string;
      cron: string[];
      timezone: string | null;
      paused: boolean;
      nextRunAt: string | null;
    }> = [];
    const workflowIds = new Set<string>();

    for await (const summary of client.schedule.list()) {
      if (!summary.scheduleId.startsWith(prefix)) continue;
      const parsed = parseLoopScheduleId(summary.scheduleId);
      if (!parsed || parsed.tenantId !== auth.tenantId) continue;
      workflowIds.add(parsed.workflowId);
      const handle = client.schedule.getHandle(summary.scheduleId);
      const description = await handle.describe();
      const spec = description.spec as { cronExpressions?: string[]; timezone?: string };
      schedules.push({
        scheduleId: summary.scheduleId,
        workflowId: parsed.workflowId,
        workflowTitle: "",
        cron: spec.cronExpressions ?? [],
        timezone: spec.timezone ?? null,
        paused: description.state.paused,
        nextRunAt: description.info.nextActionTimes[0]?.toISOString() ?? null,
      });
    }

    const titles = await loadWorkflowTitles(auth.tenantId, auth.userId, [...workflowIds]);
    res.json({
      schedules: schedules.map((schedule) => ({
        ...schedule,
        workflowTitle: titles.get(schedule.workflowId) ?? "Loop",
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list schedules" });
  }
});

router.post("/schedules/:scheduleId/pause", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  if (!isTemporalEnabled()) return temporalUnavailable(res);
  try {
    const auth = req.authContext!;
    const scheduleId = String(req.params.scheduleId);
    const parsed = parseLoopScheduleId(scheduleId);
    if (!parsed || parsed.tenantId !== auth.tenantId) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    await pauseLoopSchedule(auth.tenantId, parsed.workflowId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to pause schedule" });
  }
});

router.post("/schedules/:scheduleId/unpause", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  if (!isTemporalEnabled()) return temporalUnavailable(res);
  try {
    const auth = req.authContext!;
    const scheduleId = String(req.params.scheduleId);
    const parsed = parseLoopScheduleId(scheduleId);
    if (!parsed || parsed.tenantId !== auth.tenantId) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }
    await unpauseLoopSchedule(auth.tenantId, parsed.workflowId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to unpause schedule" });
  }
});

router.post("/workflows/:temporalWorkflowId/cancel", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  if (!isTemporalEnabled()) return temporalUnavailable(res);
  try {
    const auth = req.authContext!;
    const temporalWorkflowId = String(req.params.temporalWorkflowId);
    const parsed = parseLoopRunWorkflowId(temporalWorkflowId);
    if (!parsed || parsed.tenantId !== auth.tenantId) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(temporalWorkflowId);
    await handle.cancel();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to cancel workflow" });
  }
});

export default router;
