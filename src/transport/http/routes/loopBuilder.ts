import { Router, type Response } from "express";
import { z } from "zod";

import {
  enqueueLoopBuilderProposeJob,
  enqueueLoopBuilderRefineJob,
  enqueueSpecDraftJob,
  enqueueSpecRefineJob,
  getLoopBuilderJob,
} from "../../../services/loop-builder/jobs.js";
import {
  approveLoopSpec,
  archiveLoopSpec,
  getLoopSpec,
  listLoopSpecs,
} from "../../../services/loop-builder/specs.js";
import {
  builderTemplateHintSchema,
  saveLoopBuilderProposal,
  loopBuilderProposalSchema,
} from "../../../services/loop-builder/intent-resolver.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";

const router = Router();

const promptSchema = z.object({
  prompt: z.string().trim().min(1).max(10_000),
  templateId: builderTemplateHintSchema.optional(),
  specId: z.string().uuid().optional(),
  feedback: z.string().trim().min(1).max(5000).optional(),
  priorProposal: loopBuilderProposalSchema.optional(),
});

const specIdSchema = z.object({ specId: z.string().uuid() });

const specDraftSchema = z.object({
  prompt: z.string().trim().min(1).max(10_000),
});

const specRefineSchema = z.object({
  feedback: z.string().trim().min(1).max(5000),
});

const specApproveSchema = z.object({
  bodyMarkdown: z.string().trim().min(1).max(100_000).optional(),
  specJson: z.unknown().optional(),
});

const saveSchema = z.object({
  proposal: z.unknown(),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
});

router.use(authMiddleware);

router.get("/specs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const specs = await listLoopSpecs(req.authContext!);
    res.json({ specs });
  } catch (error) {
    console.error("Error listing loop specs:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list loop specs" });
  }
});

router.post("/specs/draft", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = specDraftSchema.parse(req.body ?? {});
    const job = enqueueSpecDraftJob({
      auth: req.authContext!,
      prompt: body.prompt,
    });
    res.status(202).json(job);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error drafting loop spec:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to draft loop spec" });
  }
});

router.get("/specs/:specId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { specId } = specIdSchema.parse(req.params);
    const spec = await getLoopSpec(req.authContext!, specId);
    if (!spec || spec.status === "archived") {
      res.status(404).json({ error: "Loop spec not found" });
      return;
    }
    res.json({ spec });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error reading loop spec:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to read loop spec" });
  }
});

router.post("/specs/:specId/refine", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { specId } = specIdSchema.parse(req.params);
    const body = specRefineSchema.parse(req.body ?? {});
    const job = enqueueSpecRefineJob({
      auth: req.authContext!,
      specId,
      feedback: body.feedback,
    });
    res.status(202).json(job);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error refining loop spec:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to refine loop spec" });
  }
});

router.post("/specs/:specId/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { specId } = specIdSchema.parse(req.params);
    const body = specApproveSchema.parse(req.body ?? {});
    const spec = await approveLoopSpec({
      auth: req.authContext!,
      specId,
      bodyMarkdown: body.bodyMarkdown,
      specJson: body.specJson,
    });
    res.json({ spec });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to approve loop spec";
    const status = /not found/i.test(message)
      ? 404
      : /outbound delivery requires/i.test(message)
        ? 400
        : 500;
    res.status(status).json({ error: message });
  }
});

router.post("/specs/:specId/archive", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { specId } = specIdSchema.parse(req.params);
    await archiveLoopSpec(req.authContext!, specId);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to archive loop spec" });
  }
});

router.post("/specs/:specId/generate", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { specId } = specIdSchema.parse(req.params);
    const spec = await getLoopSpec(req.authContext!, specId);
    if (!spec || spec.status === "archived") {
      res.status(404).json({ error: "Loop spec not found" });
      return;
    }
    if (spec.status !== "approved") {
      res.status(409).json({ error: "Loop spec must be approved before generation" });
      return;
    }
    const job = enqueueLoopBuilderProposeJob({
      auth: req.authContext!,
      prompt: spec.sourcePrompt || spec.specJson.purpose,
      specId,
    });
    res.status(202).json(job);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to generate loop from spec";
    const status = /outbound delivery requires/i.test(message) ? 400 : 500;
    console.error("Error generating loop from spec:", error);
    res.status(status).json({ error: message });
  }
});

router.get("/jobs/:jobId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const jobId = z.string().uuid().parse(req.params.jobId);
    const job = getLoopBuilderJob(req.authContext!, jobId);
    if (!job) {
      res.status(404).json({ error: "Loop builder job not found" });
      return;
    }
    res.json(job);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error reading loop builder job:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to read loop builder job" });
  }
});

router.post("/propose", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = promptSchema.parse(req.body ?? {});
    const job = enqueueLoopBuilderProposeJob({
      auth: req.authContext!,
      prompt: body.prompt,
      templateId: body.templateId,
      specId: body.specId,
      feedback: body.feedback,
    });
    res.status(202).json(job);
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
    const job = enqueueLoopBuilderRefineJob({
      auth: req.authContext!,
      prompt: body.prompt,
      templateId: body.templateId,
      specId: body.specId,
      feedback: body.feedback,
      priorProposal: body.priorProposal,
    });
    res.status(202).json(job);
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
