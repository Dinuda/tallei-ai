import { Router } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { claudeOnboardingService } from "../../../orchestration/browser/run-automation.usecase.js";

const createSessionSchema = z.object({
  projectName: z.string().trim().min(1).max(100).optional(),
  applyProjectInstructions: z.boolean().optional(),
  projectInstructions: z.string().trim().min(1).max(20000).optional(),
});

const resumeSchema = z.object({
  authCompleted: z.boolean().optional().default(true),
});

const router = Router();
router.use(authMiddleware);

function normalizeId(param: string | string[] | undefined): string | null {
  if (typeof param === "string" && param.length > 0) return param;
  return null;
}

router.post("/sessions", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  try {
    const parsed = createSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }

    const session = await claudeOnboardingService.createAndStart(req.userId!, parsed.data);
    res.status(201).json({ session });
  } catch (error) {
    console.error("Failed to create onboarding session:", error);
    res.status(500).json({ error: "Failed to create onboarding session" });
  }
});

router.get("/sessions/:id", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  try {
    const sessionId = normalizeId(req.params.id);
    if (!sessionId) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = await claudeOnboardingService.getForUser(req.userId!, sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ session });
  } catch (error) {
    console.error("Failed to fetch onboarding session:", error);
    res.status(500).json({ error: "Failed to fetch onboarding session" });
  }
});

router.get("/sessions/:id/events", requireScopes(["memory:read"]), async (req: AuthRequest, res) => {
  try {
    const sessionId = normalizeId(req.params.id);
    if (!sessionId) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const events = await claudeOnboardingService.listEventsForUser(req.userId!, sessionId);
    if (!events) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ events });
  } catch (error) {
    console.error("Failed to fetch onboarding session events:", error);
    res.status(500).json({ error: "Failed to fetch onboarding session events" });
  }
});

router.post("/sessions/:id/resume", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  try {
    const sessionId = normalizeId(req.params.id);
    if (!sessionId) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }

    const parsed = resumeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }

    const session = await claudeOnboardingService.resume(req.userId!, sessionId, parsed.data);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ session });
  } catch (error) {
    console.error("Failed to resume onboarding session:", error);
    res.status(500).json({ error: "Failed to resume onboarding session" });
  }
});

router.post("/sessions/:id/cancel", requireScopes(["memory:write"]), async (req: AuthRequest, res) => {
  try {
    const sessionId = normalizeId(req.params.id);
    if (!sessionId) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }

    const session = await claudeOnboardingService.cancel(req.userId!, sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ session });
  } catch (error) {
    console.error("Failed to cancel onboarding session:", error);
    res.status(500).json({ error: "Failed to cancel onboarding session" });
  }
});

export default router;
