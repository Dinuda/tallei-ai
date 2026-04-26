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
} from "../../../services/collab.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authMiddleware);

const createTaskSchema = z.object({
  title: z.string().trim().min(1, "title is required"),
  brief: z.string().optional(),
  firstActor: z.enum(["chatgpt", "claude"]),
  maxIterations: z.coerce.number().int().min(1).max(8).optional(),
});

const listTaskSchema = z.object({
  filter: z.enum(["all", "active", "waiting", "done"]).optional().default("all"),
});

const idParamSchema = z.object({
  id: z.string().uuid("invalid task id"),
});

const runTurnSchema = z.object({
  actor: z.enum(["chatgpt", "claude"]),
});

const submitTurnSchema = z.object({
  actor: z.enum(["chatgpt", "claude"]),
  content: z.string().trim().min(1, "content is required"),
  mark_done: z.boolean().optional().default(false),
});

const finishTaskSchema = z.object({
  reason: z.string().optional(),
});

const extendSchema = z.object({
  by: z.coerce.number().int().min(1).max(8),
});

function lastTranscriptEntry(task: { transcript: Array<{ actor: string; iteration: number; content: string; ts: string }> }) {
  if (!task.transcript.length) return null;
  return task.transcript[task.transcript.length - 1];
}

router.post("/tasks", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createTaskSchema.parse(req.body ?? {});
    const task = await createTask(
      {
        title: body.title,
        brief: body.brief ?? null,
        firstActor: body.firstActor,
        maxIterations: body.maxIterations,
      },
      req.authContext!
    );
    res.status(201).json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error creating collab task:", error);
    res.status(500).json({ error: "Failed to create collab task" });
  }
});

router.get("/tasks", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = listTaskSchema.parse(req.query ?? {});
    const tasks = await listTasks({ filter: query.filter }, req.authContext!);
    res.json({ tasks });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error listing collab tasks:", error);
    res.status(500).json({ error: "Failed to list collab tasks" });
  }
});

router.get("/tasks/:id", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
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
    console.error("Error loading collab task:", error);
    res.status(500).json({ error: "Failed to load collab task" });
  }
});

router.post("/tasks/:id/run-turn", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
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
      recent_transcript: task.transcript.slice(-6),
      context: task.context,
      fallback_context: buildTurnFallbackContext(task, body.actor),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error checking collab turn:", error);
    res.status(500).json({ error: "Failed to check collab turn" });
  }
});

router.post("/tasks/:id/submit-turn", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = submitTurnSchema.parse(req.body ?? {});
    const task = await submitTurn(
      id,
      body.actor,
      body.content,
      req.authContext!,
      { markDone: body.mark_done }
    );
    res.json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof CollabConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error submitting collab turn:", error);
    res.status(500).json({ error: "Failed to submit collab turn" });
  }
});

router.post("/tasks/:id/finish", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
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
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error finishing collab task:", error);
    res.status(500).json({ error: "Failed to finish collab task" });
  }
});

router.post("/tasks/:id/extend", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
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
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error extending collab task:", error);
    res.status(500).json({ error: "Failed to extend collab task" });
  }
});

router.delete("/tasks/:id", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    await deleteTask(id, req.authContext!);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error deleting collab task:", error);
    res.status(500).json({ error: "Failed to delete collab task" });
  }
});

export default router;
