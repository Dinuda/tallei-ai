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
import {
  abortSession,
  approvePlan,
  buildSessionFallbackContext,
  getSession,
  OrchestrationConflictError,
  OrchestrationInvalidPlanError,
  OrchestrationNotFoundError,
  startSession,
  submitAnswer,
} from "../../../services/orchestrator.js";
import { getTaskPreferences, setTaskPreferences } from "../../../services/task-preferences.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();
router.use(authMiddleware);

const createTaskSchema = z.object({
  mode: z.enum(["direct", "planning"]).optional().default("direct"),
  title: z.string().trim().min(1).optional(),
  goal: z.string().trim().min(1).optional(),
  brief: z.string().nullable().optional(),
  firstActor: z.enum(["chatgpt", "claude"]).optional().default("chatgpt"),
  maxIterations: z.coerce.number().int().min(1).max(8).optional(),
  initialContext: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

const listTaskSchema = z.object({
  filter: z.enum(["all", "active", "waiting", "done"]).optional().default("all"),
});

const idParamSchema = z.object({ id: z.string().uuid("invalid task id") });
const sessionParamSchema = z.object({ id: z.string().uuid("invalid session id") });

const planningAnswerSchema = z.object({ answer: z.string().trim().min(1) });
const planningApproveSchema = z.object({
  first_actor: z.enum(["chatgpt", "claude"]).optional(),
});

const runTurnSchema = z.object({ actor: z.enum(["chatgpt", "claude"]) });
const submitTurnSchema = z.object({
  actor: z.enum(["chatgpt", "claude"]),
  content: z.string().trim().min(1, "content is required"),
  mark_done: z.boolean().optional().default(false),
});

const finishTaskSchema = z.object({ reason: z.string().optional() });
const extendSchema = z.object({ by: z.coerce.number().int().min(1).max(8) });
const abortPlanningSchema = z.object({ reason: z.string().optional() });
const preferencesSchema = z.object({
  grillMeEnabled: z.boolean(),
});

function lastTranscriptEntry(task: { transcript: Array<{ actor: string; iteration: number; content: string; ts: string }> }) {
  if (!task.transcript.length) return null;
  return task.transcript[task.transcript.length - 1];
}

router.post("/", requireScopes(["collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createTaskSchema.parse(req.body ?? {});
    if (body.mode === "planning") {
      const goal = body.goal ?? body.title;
      if (!goal) {
        res.status(400).json({ error: "goal or title is required for planning mode" });
        return;
      }
      const result = await startSession(
        {
          goal,
          sourcePlatform: "dashboard",
          firstActorPreference: body.firstActor,
          initialContext: body.initialContext ?? body.brief ?? null,
        },
        req.authContext!
      );
      res.status(201).json({
        kind: "planning",
        session_id: result.session.id,
        status: result.session.status,
        question: result.firstQuestion,
        fallback_context: buildSessionFallbackContext(result.session),
      });
      return;
    }

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

router.get("/orchestrations/:id", requireScopes(["collab:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = sessionParamSchema.parse(req.params);
    const session = await getSession(id, req.authContext!);
    if (!session) {
      res.status(404).json({ error: "Task planning session not found" });
      return;
    }
    res.json(session);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error loading task planning session:", error);
    res.status(500).json({ error: "Failed to load task planning session" });
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

router.post("/planning/:id/answer", requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = sessionParamSchema.parse(req.params);
    const body = planningAnswerSchema.parse(req.body ?? {});
    const result = await submitAnswer(id, body.answer, req.authContext!);
    res.json({
      session_id: id,
      status: result.session.status,
      question: result.nextQuestion ?? null,
      plan: result.plan ?? result.session.plan,
      fallback_context: buildSessionFallbackContext(result.session),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationConflictError || error instanceof OrchestrationNotFoundError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error answering planning step:", error);
    res.status(500).json({ error: "Failed to answer planning step" });
  }
});

router.post("/planning/:id/approve", requireScopes(["orchestrate:write", "collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = sessionParamSchema.parse(req.params);
    const body = planningApproveSchema.parse(req.body ?? {});
    const result = await approvePlan(id, req.authContext!, {
      first_actor: body.first_actor,
    });
    res.json({ session: result.session, task: result.task });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationConflictError || error instanceof OrchestrationNotFoundError || error instanceof OrchestrationInvalidPlanError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error("Error approving plan:", error);
    res.status(500).json({ error: "Failed to approve plan" });
  }
});

router.post("/planning/:id/abort", requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = sessionParamSchema.parse(req.params);
    const body = abortPlanningSchema.parse(req.body ?? {});
    const session = await abortSession(id, req.authContext!, body.reason);
    res.json(session);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error aborting planning:", error);
    res.status(500).json({ error: "Failed to abort planning" });
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
      recent_transcript: task.transcript.slice(-6),
      context: task.context,
      fallback_context: buildTurnFallbackContext(task, body.actor),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
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
    if (error instanceof CollabNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error deleting task:", error);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

export default router;
