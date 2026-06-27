import { Router, type Response } from "express";
import { z } from "zod";
import {
  convertToModelMessages,
  streamText,
  tool,
  type UIMessage,
} from "ai";

import { applySpecPatch } from "../../../loops/patch.js";
import {
  activateLoop,
  archiveLoop,
  compileLoop,
  createLoopInWorkspace,
  getLatestSpec,
  getLoop,
  listLoopRuns,
  listLoops,
  moveLoopToWorkspace,
  pauseLoop,
  resumeLoop,
  resolveLoopAuthWorkspace,
  setLoopStatus,
  triggerManualRun,
} from "../../../loops/service.js";
import { specPatchSchema } from "../../../loops/spec.js";
import { saveSpecDraft, getLoopRun, getPendingApprovalForRun, listLoopRunSteps } from "../../../loops/store.js";
import { buildConductorSystemPrompt } from "../../../loops/planning-agent.js";
import { getStreamingLanguageModel } from "../../../providers/ai/streaming/language-model.js";
import { listWorkspaceConnectors, startToolkitAuthorization } from "../../../integrations/composio/accounts.js";
import { getWorkspace } from "../../../services/workspace/index.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();
router.use(authMiddleware);
router.use(workspaceMiddleware);

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.errors });
    return;
  }
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message) ? 404 : /not connected|invalid/i.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
}

const loopIdSchema = z.object({ loopId: z.string().uuid() });

router.get("/", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const auth = await resolveLoopAuthWorkspace(req.authContext!);
    const loops = await listLoops(auth, auth.workspaceId!);
    res.json({ loops, workspaceId: auth.workspaceId });
  } catch (error) {
    sendError(res, error, "Failed to list loops");
  }
});

router.post("/", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({
      name: z.string().min(1).max(200),
      templateId: z.string().optional(),
      workspaceId: z.string().uuid().optional(),
    }).parse(req.body ?? {});
    const created = await createLoopInWorkspace(req.authContext!, body);
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error, "Failed to create loop");
  }
});

router.get("/:loopId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const loop = await getLoop(req.authContext!, loopId);
    if (!loop) {
      res.status(404).json({ error: "Loop not found" });
      return;
    }
    const spec = await getLatestSpec(req.authContext!, loopId);
    res.json({ loop, spec });
  } catch (error) {
    sendError(res, error, "Failed to read loop");
  }
});

router.post("/:loopId/compile", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const result = await compileLoop(req.authContext!, loopId);
    if (result.errors.length > 0) {
      res.status(400).json({ errors: result.errors });
      return;
    }
    res.json({ plan: result.plan });
  } catch (error) {
    sendError(res, error, "Failed to compile loop");
  }
});

router.post("/:loopId/activate", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const { compiledPlanId } = z.object({ compiledPlanId: z.string().uuid() }).parse(req.body ?? {});
    const result = await activateLoop(req.authContext!, loopId, compiledPlanId);
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to activate loop");
  }
});

router.post("/:loopId/pause", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const result = await pauseLoop(req.authContext!, loopId);
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to pause loop");
  }
});

router.post("/:loopId/resume", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const result = await resumeLoop(req.authContext!, loopId);
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to resume loop");
  }
});

router.get("/:loopId/runs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const runs = await listLoopRuns(req.authContext!, loopId);
    res.json({ runs });
  } catch (error) {
    sendError(res, error, "Failed to list runs");
  }
});

router.get("/:loopId/runs/:runId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const { runId } = z.object({ runId: z.string().uuid() }).parse(req.params);
    const run = await getLoopRun(req.authContext!, loopId, runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const steps = await listLoopRunSteps(req.authContext!, loopId, runId);
    const pendingApproval = await getPendingApprovalForRun(req.authContext!, loopId, runId);
    res.json({ run, steps, pendingApproval });
  } catch (error) {
    sendError(res, error, "Failed to read run");
  }
});

router.post("/:loopId/runs", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const run = await triggerManualRun(req.authContext!, loopId);
    res.status(201).json({ run });
  } catch (error) {
    sendError(res, error, "Failed to trigger run");
  }
});

router.post("/:loopId/move", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(req.body ?? {});
    const result = await moveLoopToWorkspace(req.authContext!, loopId, workspaceId);
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to move loop");
  }
});

router.delete("/:loopId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const result = await archiveLoop(req.authContext!, loopId);
    res.json(result);
  } catch (error) {
    sendError(res, error, "Failed to archive loop");
  }
});

router.post("/:loopId/chat", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const body = z.object({
      messages: z.array(z.custom<UIMessage>()),
    }).parse(req.body ?? {});

    const auth = await resolveLoopAuthWorkspace(req.authContext!);
    const loop = await getLoop(auth, loopId);
    if (!loop) {
      res.status(404).json({ error: "Loop not found" });
      return;
    }

    let currentSpec = await getLatestSpec(auth, loopId);
    if (!currentSpec) {
      res.status(400).json({ error: "Loop spec not found" });
      return;
    }

    const workspace = await getWorkspace(auth, loop.workspaceId);
    const initialConnectors = await listWorkspaceConnectors(auth);

    const result = streamText({
      model: getStreamingLanguageModel("conductor"),
      system: buildConductorSystemPrompt({
        workspaceName: workspace.name,
        spec: currentSpec,
        connectedToolkits: initialConnectors.map((t) => ({
          slug: t.slug,
          name: t.name,
          connected: Boolean(t.connected),
        })),
      }),
      messages: await convertToModelMessages(body.messages),
      tools: {
        patchLoopSpec: tool({
          description: "Apply a partial update to the loop spec",
          inputSchema: specPatchSchema,
          execute: async (patch) => {
            currentSpec = applySpecPatch(currentSpec!, patch);
            await saveSpecDraft(auth, loopId, currentSpec, "chat");
            const { getMissingSlots } = await import("../../../loops/patch.js");
            return {
              ok: true,
              missingSlots: getMissingSlots(currentSpec),
              spec: currentSpec,
            };
          },
        }),
        listConnectors: tool({
          description: "List connected accounts in this workspace",
          inputSchema: z.object({}),
          execute: async () => {
            const connectors = await listWorkspaceConnectors(auth);
            return {
              connectors: connectors.map((t) => ({
                slug: t.slug,
                name: t.name,
                connected: t.connected,
                connectedAccountId: t.connectedAccountId ?? null,
              })),
            };
          },
        }),
        connectToolkit: tool({
          description: "Start OAuth for a toolkit that is not connected yet",
          inputSchema: z.object({
            toolkit: z.string().min(1),
            callbackUrl: z.string().url().optional(),
          }),
          execute: async ({ toolkit, callbackUrl }) => {
            const authorization = await startToolkitAuthorization(auth, toolkit, { callbackUrl });
            return {
              ok: true,
              toolkit: authorization.toolkit,
              redirectUrl: authorization.redirectUrl,
              connectionRequestId: authorization.connectionRequestId,
            };
          },
        }),
      },
    });

    result.pipeUIMessageStreamToResponse(res);
  } catch (error) {
    sendError(res, error, "Failed to stream Conductor chat");
  }
});

export default router;
