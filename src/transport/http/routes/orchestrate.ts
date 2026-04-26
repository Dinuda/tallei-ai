import { Router, Response } from "express";
import { z } from "zod";

import {
  abortSession,
  approvePlan,
  buildSessionFallbackContext,
  getSession,
  listSessions,
  OrchestrationConflictError,
  OrchestrationNotFoundError,
  startSession,
  submitAnswer,
} from "../../../services/orchestrator.js";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authMiddleware);

const createSessionSchema = z.object({
  goal: z.string().trim().min(1, "goal is required"),
  source_platform: z.enum(["claude", "chatgpt", "dashboard"]).optional().default("dashboard"),
  first_actor_preference: z.enum(["chatgpt", "claude"]).optional(),
  initial_context: z.string().optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid("invalid session id"),
});

const answerSchema = z.object({
  answer: z.string().trim().min(1, "answer is required"),
});

const approveSchema = z.object({
  overrides: z
    .object({
      first_actor: z.enum(["chatgpt", "claude"]).optional(),
      max_iterations: z.coerce.number().int().min(1).max(8).optional(),
    })
    .optional(),
});

const abortSchema = z.object({
  reason: z.string().optional(),
});

const listSchema = z.object({
  filter: z.enum(["all", "active", "done"]).optional().default("all"),
});

router.post("/sessions", requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = createSessionSchema.parse(req.body ?? {});
    const result = await startSession(
      {
        goal: body.goal,
        sourcePlatform: body.source_platform,
        firstActorPreference: body.first_actor_preference,
        initialContext: body.initial_context ?? null,
      },
      req.authContext!
    );

    res.status(201).json({
      session: result.session,
      question: result.firstQuestion,
      fallback_context: buildSessionFallbackContext(result.session),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error creating orchestration session:", error);
    res.status(500).json({ error: "Failed to create orchestration session" });
  }
});

router.post("/sessions/:id/answer", requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = answerSchema.parse(req.body ?? {});
    const result = await submitAnswer(id, body.answer, req.authContext!);

    res.json({
      session: result.session,
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
    if (error instanceof OrchestrationConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof OrchestrationNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error submitting orchestration answer:", error);
    res.status(500).json({ error: "Failed to submit answer" });
  }
});

router.post("/sessions/:id/approve", requireScopes(["orchestrate:write", "collab:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = approveSchema.parse(req.body ?? {});

    const result = await approvePlan(id, req.authContext!, body.overrides);
    res.json({
      session: result.session,
      task: result.task,
      task_id: result.task.id,
      plan_summary: result.session.plan?.summary ?? result.task.brief,
      success_criteria: result.session.plan?.success_criteria ?? [],
      first_actor: result.session.plan?.first_actor ?? "chatgpt",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof OrchestrationNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error approving orchestration plan:", error);
    res.status(500).json({ error: "Failed to approve plan" });
  }
});

router.post("/sessions/:id/abort", requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = abortSchema.parse(req.body ?? {});
    const session = await abortSession(id, req.authContext!, body.reason);
    res.json({ session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    if (error instanceof OrchestrationNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("Error aborting orchestration session:", error);
    res.status(500).json({ error: "Failed to abort session" });
  }
});

router.get("/sessions/:id", requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const session = await getSession(id, req.authContext!);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({
      session,
      fallback_context: buildSessionFallbackContext(session),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error loading orchestration session:", error);
    res.status(500).json({ error: "Failed to load session" });
  }
});

router.get("/sessions", requireScopes(["orchestrate:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const query = listSchema.parse(req.query ?? {});
    const sessions = await listSessions({ filter: query.filter }, req.authContext!);
    res.json({ sessions });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error listing orchestration sessions:", error);
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

export default router;
