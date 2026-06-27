import { Router, type Response } from "express";
import { z } from "zod";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";

import { applySpecPatch } from "../../../loops/patch.js";
import {
  activateLoopInputSchema,
  askQuestionInputSchema,
  compileLoopInputSchema,
  decomposeTaskInputSchema,
  discoverBindingsInputSchema,
  discoverConnectorsForBlueprintInputSchema,
  pickConnectorAppInputSchema,
  presentReplyOptionsInputSchema,
  testRunLoopInputSchema,
} from "../../../loops/conductor-tools.js";
import { discoverOutcomeBindings } from "../../../loops/binding-discovery.js";
import { discoverConnectorsForBlueprint } from "../../../loops/connector-discovery.js";
import { decomposeTask, validateConnectorChoicesBeforeSpecPatch } from "../../../loops/task-decomposition.js";
import { executeLoopTestRun } from "../../../loops/test-run.js";
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
import { saveSpecDraft, getLoopRun, getPendingApprovalForRun, listLoopRunSteps, getConductorChatMessages, saveConductorChatMessages, getBuildChatThreadMeta, getRunChatMessages, getLatestPassingTestRunForPlan, getLoopEventTriggerStatus } from "../../../loops/store.js";
import { composioWebhookDeliveryUrl, isLocalWebhookUrl } from "../../../integrations/composio/webhook-subscription.js";
import { deriveLoopNameFromPrompt } from "../../../loops/loop-name.js";
import { buildConductorSystemPrompt } from "../../../loops/planning-agent.js";
import { getStreamingLanguageModel } from "../../../providers/ai/streaming/language-model.js";
import { listAllToolkitsWithStatus, listWorkspaceConnectors, startToolkitAuthorization } from "../../../integrations/composio/accounts.js";
import { listComposioTriggerTypes } from "../../../integrations/composio/triggers.js";
import { resolveToolkitSlug } from "../../../integrations/composio/auth.js";
import { getAllTools } from "../../../integrations/composio/tools.js";
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
      name: z.string().min(1).max(200).optional(),
      prompt: z.string().min(1).max(4_000).optional(),
      templateId: z.string().optional(),
      workspaceId: z.string().uuid().optional(),
    }).superRefine((value, ctx) => {
      if (!value.name?.trim() && !value.prompt?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Either name or prompt is required",
          path: ["prompt"],
        });
      }
    }).parse(req.body ?? {});

    const prompt = body.prompt?.trim();
    const name = body.name?.trim() || (prompt ? deriveLoopNameFromPrompt(prompt) : "");
    const created = await createLoopInWorkspace(req.authContext!, {
      ...body,
      name,
      prompt,
    });
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
    const chatMessages = await getConductorChatMessages(req.authContext!, loopId);
    const buildChat = await getBuildChatThreadMeta(req.authContext!, loopId);
    const { getMissingSlots } = await import("../../../loops/patch.js");
    const missingSlots = spec ? getMissingSlots(spec) : [];
    const eventTrigger = await getLoopEventTriggerStatus(loopId);
    const webhookUrl = composioWebhookDeliveryUrl();
    res.json({
      loop,
      spec,
      chatMessages,
      buildChat,
      missingSlots,
      eventTrigger,
      webhookDelivery: {
        url: webhookUrl,
        reachableByComposio: !isLocalWebhookUrl(webhookUrl),
      },
    });
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
    const chatMessages = await getRunChatMessages(req.authContext!, loopId, runId);
    res.json({ run, steps, pendingApproval, chatMessages });
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

router.put("/:loopId/chat", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const body = z.object({
      messages: z.array(z.custom<UIMessage>()),
    }).parse(req.body ?? {});
    const auth = await resolveLoopAuthWorkspace(req.authContext!);
    const messages = await saveConductorChatMessages(auth, loopId, body.messages);
    res.json({ ok: true, messages });
  } catch (error) {
    sendError(res, error, "Failed to save Conductor chat");
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
    const buildMeta = await getBuildChatThreadMeta(auth, loopId);
    let latestCompiledPlanId = buildMeta?.compiledPlanId ?? null;
    let latestTestRunPass: { planId: string; runId: string } | null = null;
    if (latestCompiledPlanId) {
      const storedPass = await getLatestPassingTestRunForPlan(auth, loopId, latestCompiledPlanId);
      if (storedPass) {
        latestTestRunPass = { planId: latestCompiledPlanId, runId: storedPass.runId };
      }
    }

    const result = streamText({
      model: getStreamingLanguageModel("conductor", { userId: auth.userId }),
      stopWhen: stepCountIs(16),
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
          description:
            "Apply a partial update to the loop spec. Patch taskBlueprint after pickConnectorApp answers. Do NOT patch bindings, event triggers, or output.connector until every blueprint outcome is chosen.",
          inputSchema: specPatchSchema,
          execute: async (patch) => {
            const gate = validateConnectorChoicesBeforeSpecPatch(currentSpec!, patch);
            if (!gate.ok) {
              return {
                ok: false,
                error: gate.error,
                pendingOutcomes: gate.pendingOutcomes,
                missingSlots: (await import("../../../loops/patch.js")).getMissingSlots(currentSpec!),
              };
            }
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
          description:
            "Read-only: workspace connector status snapshot. Do NOT use this to pick connectors — use discoverConnectorsForBlueprint + pickConnectorApp instead.",
          inputSchema: z.object({}),
          execute: async () => {
            const connectors = await listWorkspaceConnectors(auth);
            return {
              note: "Do not select connectors from this list. Run discoverConnectorsForBlueprint once, then pickConnectorApp.",
              connectors: connectors.map((t) => ({
                slug: t.slug,
                name: t.name,
                connected: t.connected,
                connectedAccountId: t.connectedAccountId ?? null,
              })),
            };
          },
        }),
        listConnectorCatalog: tool({
          description:
            "Full Composio toolkit catalogue merged with workspace connection status. Browse only — use discoverConnectorsForBlueprint to rank connectors for the whole blueprint.",
          inputSchema: z.object({}),
          execute: async () => {
            const { toolkits, total } = await listAllToolkitsWithStatus(auth);
            return {
              total,
              toolkits: toolkits.map((toolkit) => ({
                slug: toolkit.slug,
                name: toolkit.name,
                description: toolkit.description,
                category: toolkit.category ?? null,
                connected: toolkit.connected,
                connectedAccountId: toolkit.connectedAccountId ?? null,
              })),
            };
          },
        }),
        decomposeTask: tool({
          description:
            "Break the user's goal into outcome roles (source, destination, trigger, transform). Call early before picking connectors. Patch taskBlueprint from the result.",
          inputSchema: decomposeTaskInputSchema,
          execute: async (input) => decomposeTask(input),
        }),
        discoverConnectorsForBlueprint: tool({
          description:
            "REQUIRED once after decomposeTask. Ranks unique apps for the whole loop (each app once). Returns askOptions, recommendedOptionIds (top 5), and defaultQuestion. Always follow with pickConnectorApp — never askQuestion for this step.",
          inputSchema: discoverConnectorsForBlueprintInputSchema,
          execute: async (input) => discoverConnectorsForBlueprint(auth, input),
        }),
        pickConnectorApp: tool({
          description:
            "Present the app picker after discoverConnectorsForBlueprint. Pass optional question text only — the UI injects ranked app options from discovery. One app pick for the whole loop; triggers/bindings come later.",
          inputSchema: pickConnectorAppInputSchema,
        }),
        presentReplyOptions: tool({
          description:
            "Show clickable quick-reply chips when asking the user to confirm a next step (compile, test, activate) or any yes/no choice. Call alongside your message with 2–4 short labels and the full user message each chip sends.",
          inputSchema: presentReplyOptionsInputSchema,
        }),
        listTriggers: tool({
          description: "List available Composio event triggers for a toolkit",
          inputSchema: z.object({ toolkit: z.string().min(1) }),
          execute: async ({ toolkit }) => {
            const resolved = await resolveToolkitSlug(toolkit);
            const triggers = await listComposioTriggerTypes(resolved);
            return { toolkit: resolved, triggers };
          },
        }),
        listActions: tool({
          description: "List available Composio actions for a toolkit (for binding resolution)",
          inputSchema: z.object({ toolkit: z.string().min(1) }),
          execute: async ({ toolkit }) => {
            const resolved = await resolveToolkitSlug(toolkit);
            const actions = await getAllTools(resolved);
            return {
              toolkit: resolved,
              actions: actions.map((action) => ({
                slug: action.actionSlug,
                name: action.name,
                description: action.description,
              })),
            };
          },
        }),
        discoverBindings: tool({
          description:
            "Search Composio and rank action bindings for inferred outcomes. Returns suggestedBindings — auto-apply them. needsUserChoice is rare (send vs draft forks only); never ask about fetch/list API details.",
          inputSchema: discoverBindingsInputSchema,
          execute: async (input) => discoverOutcomeBindings(input.toolkit, input.outcomes),
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
        askQuestion: tool({
          description:
            "Ask the user ONE question for genuine business forks (approval, schedule, destination). Forbidden: connector app choice (use pickConnectorApp), Composio slugs, fetch strategies, or API implementation details.",
          inputSchema: askQuestionInputSchema,
        }),
        compileLoop: tool({
          description:
            "Freeze the current spec and compile it into a runnable plan. Call when the user confirms they are ready — resolve compile blockers first.",
          inputSchema: compileLoopInputSchema,
          execute: async () => {
            const compiled = await compileLoop(auth, loopId);
            if (compiled.errors.length > 0) {
              return { ok: false as const, errors: compiled.errors };
            }
            latestCompiledPlanId = compiled.plan!.id;
            latestTestRunPass = null;
            return {
              ok: true as const,
              plan: {
                id: compiled.plan!.id,
                revision: compiled.plan!.revision,
                toolCount: compiled.plan!.toolCatalog.length,
                profile: compiled.plan!.profile,
              },
            };
          },
        }),
        testRunLoop: tool({
          description:
            "Run a fast simulated smoke test against the compiled plan before activation. Pass compiledPlanId (optional) and scenario only — do NOT pass maxSteps or timeoutMs.",
          inputSchema: testRunLoopInputSchema,
          execute: async ({ compiledPlanId, scenario }) => {
            const planId = compiledPlanId ?? latestCompiledPlanId ?? buildMeta?.compiledPlanId ?? null;
            if (!planId) {
              return { ok: false as const, error: "No compiled plan — call compileLoop first" };
            }
            const result = await executeLoopTestRun(auth, {
              loopId,
              compiledPlanId: planId,
              scenario,
            });
            if (result.ok) {
              latestTestRunPass = { planId, runId: result.runId };
            }
            return result;
          },
        }),
        activateLoop: tool({
          description:
            "Activate a compiled plan so event triggers and schedules start firing. Requires a prior passing testRunLoop on the same plan (persisted — do not re-test).",
          inputSchema: activateLoopInputSchema,
          execute: async ({ compiledPlanId }) => {
            const planId = compiledPlanId ?? latestCompiledPlanId ?? buildMeta?.compiledPlanId ?? null;
            if (!planId) {
              return { ok: false as const, error: "No compiled plan — call compileLoop first" };
            }
            const inMemoryPass = latestTestRunPass?.planId === planId ? latestTestRunPass : null;
            const storedPass = inMemoryPass
              ? inMemoryPass
              : await getLatestPassingTestRunForPlan(auth, loopId, planId);
            if (!storedPass) {
              return { ok: false as const, error: "Run testRunLoop on this plan before activating" };
            }
            const activated = await activateLoop(auth, loopId, planId);
            latestCompiledPlanId = activated.activePlanId;
            return { ok: true as const, ...activated };
          },
        }),
      },
    });

    result.pipeUIMessageStreamToResponse(res, {
      sendReasoning: true,
      originalMessages: body.messages,
      onFinish: async ({ messages, isAborted }) => {
        if (isAborted) return;
        try {
          await saveConductorChatMessages(auth, loopId, messages);
        } catch (error) {
          console.error("[loops/chat] failed to persist conductor transcript:", error);
        }
      },
    });
  } catch (error) {
    sendError(res, error, "Failed to stream Conductor chat");
  }
});

export default router;
