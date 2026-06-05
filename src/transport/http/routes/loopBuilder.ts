import { Router, type Response } from "express";
import { z } from "zod";

import {
  builderTemplateHintSchema,
  refineLoopBuilderProposal,
  resolveLoopBuilderIntent,
  saveLoopBuilderProposal,
  loopBuilderProposalSchema,
} from "../../../services/loop-builder/intent-resolver.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

const promptSchema = z.object({
  prompt: z.string().trim().min(1).max(10_000),
  templateId: builderTemplateHintSchema.optional(),
  feedback: z.string().trim().min(1).max(5000).optional(),
  priorProposal: loopBuilderProposalSchema.optional(),
});

const saveSchema = z.object({
  proposal: z.unknown(),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
});

router.use(authMiddleware);

router.post("/propose", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = promptSchema.parse(req.body ?? {});
    const proposal = await resolveLoopBuilderIntent({
      auth: req.authContext!,
      prompt: body.prompt,
      templateId: body.templateId,
      feedback: body.feedback,
      priorProposal: body.priorProposal,
    });
    res.json({ proposal });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error proposing loop:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to propose loop" });
  }
});

router.post("/refine", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = promptSchema.parse(req.body ?? {});
    if (!body.priorProposal) {
      res.status(400).json({ error: "priorProposal is required for refine" });
      return;
    }
    const proposal = await refineLoopBuilderProposal({
      auth: req.authContext!,
      prompt: body.prompt,
      templateId: body.templateId,
      feedback: body.feedback,
      priorProposal: body.priorProposal,
    });
    res.json({ proposal });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error refining loop:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to refine loop" });
  }
});

router.post("/save", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveSchema.parse(req.body ?? {});
    const loop = await saveLoopBuilderProposal({
      auth: req.authContext!,
      proposal: body.proposal,
      cron: body.cron,
      timezone: body.timezone,
      workspaceId: body.workspaceId,
    });
    res.status(201).json({ loop });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error saving loop:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save loop" });
  }
});

export default router;
