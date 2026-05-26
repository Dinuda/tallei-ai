import { Router, Response } from "express";
import { z } from "zod";

import {
  buildTurnFallbackContext,
  claimTurn,
  CollabConflictError,
  CollabNotFoundError,
  createTask,
  deleteTask,
  extendIterations,
  finishTask,
  getTask,
  listTasks,
  submitTurn,
} from "../../../services/collab/collab.service.js";
import { getTaskPreferences, setTaskPreferences } from "../../../services/task-preferences.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

const createTaskSchema = z.object({
  title: z.string().trim().min(1).optional(),
  goal: z.string().trim().min(1).optional(),
  brief: z.string().nullable().optional(),
  firstActor: z.enum(["chatgpt", "claude"]).optional().default("chatgpt"),
  maxIterations: z.coerce.number().int().min(1).optional(),
  context: z.record(z.unknown()).optional(),
});

const listTaskSchema = z.object({
  filter: z.enum(["all", "active", "waiting", "done"]).optional().default("all"),
});

const idParamSchema = z.object({ id: z.string().uuid("invalid task id") });
const runTurnSchema = z.object({ actor: z.enum(["chatgpt", "claude"]) });
const submitTurnSchema = z.object({
  actor: z.enum(["chatgpt", "claude"]),
  content: z.string().trim().min(1, "content is required"),
});

const finishTaskSchema = z.object({ reason: z.string().optional() });
const extendSchema = z.object({ by: z.coerce.number().int().min(1).max(8) });
const preferencesSchema = z.object({
  grillMeEnabled: z.boolean(),
});

function lastTranscriptEntry(task: { transcript: Array<{ actor: string; iteration: number; content: string; ts: string }> }) {
  if (!task.transcript.length) return null;
  return task.transcript[task.transcript.length - 1];
}

function sendPlanRequired(res: Response, error: PlanRequiredError): void {
  res.status(402).json({
    error: error.message,
    code: "plan_required",
    feature: "collab_sessions",
  });
}

router.post("/", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createTaskSchema.parse(req.body ?? {});
    const title = body.title ?? body.goal;
    if (!title) {
      res.status(400).json({ error: "title or goal is required" });
      return;
    }
    const task = await createTask(
      {
        title,
        brief: body.brief ?? null,
        firstActor: body.firstActor,
        maxIterations: body.maxIterations,
        context: body.context ?? null,
      },
      req.authContext!
    );
    res.status(201).json({ kind: "execution", task });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      sendPlanRequired(res, error);
      return;
    }
    console.error("Error creating task:", error);
    res.status(500).json({ error: "Failed to create task" });
  }
});

router.get("/", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = listTaskSchema.parse(req.query ?? {});
    const tasks = await listTasks({ filter: query.filter }, req.authContext!);
    res.json({ tasks });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error listing tasks:", error);
    res.status(500).json({ error: "Failed to list tasks" });
  }
});

router.get("/preferences", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const prefs = await getTaskPreferences(req.authContext!);
    res.json(prefs);
  } catch (error) {
    console.error("Error loading task preferences:", error);
    res.status(500).json({ error: "Failed to load task preferences" });
  }
});

router.put("/preferences", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = preferencesSchema.parse(req.body ?? {});
    const prefs = await setTaskPreferences(req.authContext!, body);
    res.json(prefs);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error saving task preferences:", error);
    res.status(500).json({ error: "Failed to save task preferences" });
  }
});

router.get("/:id", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const task = await getTask(id, req.authContext!);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error loading task:", error);
    res.status(500).json({ error: "Failed to load task" });
  }
});

router.post("/:id/run-turn", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = runTurnSchema.parse(req.body ?? {});

    const claim = await claimTurn(id, body.actor, req.authContext!);
    const task = claim ?? (await getTask(id, req.authContext!));
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json({
      is_my_turn: Boolean(claim),
      task_id: task.id,
      title: task.title,
      brief: task.brief,
      state: task.state,
      iteration: task.iteration,
      max_iterations: task.maxIterations,
      last_message: lastTranscriptEntry(task),
      recent_transcript: task.transcript,
      context: task.context,
      fallback_context: buildTurnFallbackContext(task, body.actor),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      sendPlanRequired(res, error);
      return;
    }
    console.error("Error checking turn:", error);
    res.status(500).json({ error: "Failed to check turn" });
  }
});

router.post("/:id/submit-turn", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = submitTurnSchema.parse(req.body ?? {});
    const task = await submitTurn(
      id,
      body.actor,
      body.content,
      req.authContext!
    );
    res.json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      sendPlanRequired(res, error);
      return;
    }
    if (error instanceof CollabConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error submitting turn:", error);
    res.status(500).json({ error: "Failed to submit turn" });
  }
});

router.post("/:id/finish", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = finishTaskSchema.parse(req.body ?? {});
    const task = await finishTask(id, req.authContext!, body.reason);
    res.json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      sendPlanRequired(res, error);
      return;
    }
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error finishing task:", error);
    res.status(500).json({ error: "Failed to finish task" });
  }
});

router.post("/:id/extend", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = extendSchema.parse(req.body ?? {});
    const task = await extendIterations(id, body.by, req.authContext!);
    res.json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      sendPlanRequired(res, error);
      return;
    }
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error extending task:", error);
    res.status(500).json({ error: "Failed to extend task" });
  }
});

router.delete("/:id", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    await deleteTask(id, req.authContext!);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof PlanRequiredError) {
      sendPlanRequired(res, error);
      return;
    }
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error deleting task:", error);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

export default router;
