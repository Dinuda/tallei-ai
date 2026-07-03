import { Router, type Response } from "express";
import { z } from "zod";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";

import { applyPendingIntentAnswersFromTranscript, sanitizeConductorChatMessages } from "../../../loops/conductor-chat.js";
import { isIntentResolutionPatch } from "../../../loops/intent-analysis.js";
import { applySpecPatch } from "../../../loops/patch.js";
import {
  activateLoopInputSchema,
  analyzeIntentInputSchema,
  askQuestionInputSchema,
  compileLoopInputSchema,
  connectToolkitInputSchema,
  confirmOutcomeBriefInputSchema,
  discoverBindingsInputSchema,
  discoverConnectorsForBlueprintInputSchema,
  listActionsInputSchema,
  listTriggersInputSchema,
  listWorkspaceConnectorsInputSchema,
  pickConnectorAppInputSchema,
  presentReplyOptionsInputSchema,
  testRunLoopInputSchema,
} from "../../../loops/conductor-tools.js";
import { computeOutcomeBriefHash } from "../../../loops/outcome-brief.js";
import { discoverOutcomeBindings } from "../../../loops/binding-discovery.js";
import { discoverConnectorsForBlueprint } from "../../../loops/connector-discovery.js";
import { validateConnectorChoicesBeforeSpecPatch } from "../../../loops/task-decomposition.js";
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
  renameLoop,
  resumeLoop,
  resolveLoopAuthWorkspace,
  triggerManualRun,
} from "../../../loops/service.js";
import { specPatchSchema } from "../../../loops/spec.js";
import { saveSpecDraft, getLoopRun, getPendingApprovalForRun, listLoopRunSteps, getConductorChatMessages, saveConductorChatMessages, getBuildChatThreadMeta, getRunChatMessages, getLatestPassingTestRunForPlan, getLoopEventTriggerStatus } from "../../../loops/store.js";
import { buildIntentAnalysisSpecPatch } from "../../../loops/intent-analysis.js";
import { composioWebhookDeliveryUrl, isLocalWebhookUrl } from "../../../integrations/composio/webhook-subscription.js";
import { deriveLoopNameFromPrompt } from "../../../loops/loop-name.js";
import { resolveActivationGap } from "../../../loops/activation-status.js";
import {
  CONDUCTOR_TOOL_DESCRIPTIONS,
} from "../../../loops/conductor-chat-prompts.js";
import { buildConductorSystemPrompt } from "../../../loops/planning-agent.js";
import { getStreamingLanguageModel } from "../../../providers/ai/streaming/language-model.js";
import { listWorkspaceConnectors, startToolkitAuthorization } from "../../../integrations/composio/accounts.js";
import { resolveEventTriggerPatch, eventTriggerResolutionHint } from "../../../loops/event-trigger.js";
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
    const triggerKind = spec?.trigger && typeof spec.trigger === "object" && !Array.isArray(spec.trigger)
      ? String((spec.trigger as Record<string, unknown>).kind ?? "")
      : "";
    const activationGap = resolveActivationGap({
      triggerKind,
      loopStatus: loop.status,
      hasCompiledPlan: Boolean(buildChat?.compiledPlanId || loop.activePlanId),
      eventTrigger,
    });
    res.json({
      loop,
      spec,
      chatMessages,
      buildChat,
      missingSlots,
      eventTrigger,
      activationGap,
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

router.patch("/:loopId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const body = z.object({
      name: z.string().min(1).max(200),
    }).parse(req.body ?? {});
    const loop = await renameLoop(req.authContext!, loopId, body.name);
    res.json({ loop });
  } catch (error) {
    sendError(res, error, "Failed to update loop");
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

    const chatMessages = sanitizeConductorChatMessages(body.messages);

    let currentSpec = await getLatestSpec(auth, loopId);
    if (!currentSpec) {
      res.status(400).json({ error: "Loop spec not found" });
      return;
    }

    const intentHandoff = applyPendingIntentAnswersFromTranscript(chatMessages, currentSpec);
    if (intentHandoff.applied) {
      currentSpec = intentHandoff.spec;
      await saveSpecDraft(auth, loopId, currentSpec, "intent-answer");
    }

    const [workspace, initialConnectors, buildMeta] = await Promise.all([
      getWorkspace(auth, loop.workspaceId),
      listWorkspaceConnectors(auth),
      getBuildChatThreadMeta(auth, loopId),
    ]);
    let latestCompiledPlanId = buildMeta?.compiledPlanId ?? null;
    let latestTestRunPass: { planId: string; runId: string } | null = null;
    if (intentHandoff.applied) {
      latestCompiledPlanId = null;
      latestTestRunPass = null;
    }
    if (latestCompiledPlanId) {
      const storedPass = await getLatestPassingTestRunForPlan(auth, loopId, latestCompiledPlanId);
      if (storedPass) {
        latestTestRunPass = { planId: latestCompiledPlanId, runId: storedPass.runId };
      }
    }

    const buildCurrentSystemPrompt = () => buildConductorSystemPrompt({
      workspaceName: workspace.name,
      spec: currentSpec!,
      confirmationHash: computeOutcomeBriefHash(currentSpec!),
      connectedToolkits: initialConnectors.map((t) => ({
        slug: t.slug,
        name: t.name,
        connected: Boolean(t.connected),
      })),
    });

    const result = streamText({
      model: getStreamingLanguageModel("conductor", { userId: auth.userId }),
      stopWhen: stepCountIs(16),
      system: buildCurrentSystemPrompt(),
      prepareStep: () => ({ system: buildCurrentSystemPrompt() }),
      messages: await convertToModelMessages(chatMessages),
      tools: {
        analyzeIntent: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent,
          inputSchema: analyzeIntentInputSchema,
          execute: async (analysis) => {
            const { patch, nextQuestion } = buildIntentAnalysisSpecPatch(currentSpec!, analysis);
            currentSpec = applySpecPatch(currentSpec!, patch);
            await saveSpecDraft(auth, loopId, currentSpec, "intent-analysis");
            latestCompiledPlanId = null;
            latestTestRunPass = null;
            return {
              ok: true,
              status: currentSpec.intentDiscovery.status,
              analysis,
              spec: currentSpec,
              ...(nextQuestion ? {
                nextQuestion: {
                  questionId: nextQuestion.id,
                  question: nextQuestion.question,
                  options: nextQuestion.options,
                  allowMultiple: false,
                  allowOther: true,
                },
              } : {}),
            };
          },
        }),
        patchLoopSpec: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.patchLoopSpec,
          inputSchema: specPatchSchema,
          execute: async (patch) => {
            const intentStatus = currentSpec!.intentDiscovery.status;
            if (
              (intentStatus === "pending" || intentStatus === "needs_input")
              && !isIntentResolutionPatch(patch)
            ) {
              return {
                ok: false,
                error: "Intent is not resolved yet. Finish analyzeIntent / askQuestion until status is ready before patching the loop spec.",
                intentStatus,
              };
            }
            const gate = validateConnectorChoicesBeforeSpecPatch(currentSpec!, patch);
            if (!gate.ok) {
              return {
                ok: false,
                error: gate.error,
                pendingOutcomes: gate.pendingOutcomes,
                missingSlots: (await import("../../../loops/patch.js")).getMissingSlots(currentSpec!),
              };
            }
            let normalizedPatch = patch;
            try {
              normalizedPatch = await resolveEventTriggerPatch(currentSpec!, patch);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const source = patch.trigger?.kind === "event"
                ? (patch.trigger.source?.trim()
                  || (currentSpec!.trigger.kind === "event" ? currentSpec!.trigger.source : ""))
                : "";
              return {
                ok: false,
                error: message,
                ...(source ? { hint: eventTriggerResolutionHint(source) } : {}),
                missingSlots: (await import("../../../loops/patch.js")).getMissingSlots(currentSpec!),
              };
            }
            try {
              currentSpec = applySpecPatch(currentSpec!, normalizedPatch);
            } catch (error) {
              const message = error instanceof z.ZodError
                ? error.errors.map((row) => row.message).join("; ")
                : error instanceof Error ? error.message : String(error);
              return {
                ok: false,
                error: message,
                missingSlots: (await import("../../../loops/patch.js")).getMissingSlots(currentSpec!),
              };
            }
            await saveSpecDraft(auth, loopId, currentSpec, "chat");
            latestCompiledPlanId = null;
            latestTestRunPass = null;
            const { getMissingSlots } = await import("../../../loops/patch.js");
            return {
              ok: true,
              missingSlots: getMissingSlots(currentSpec),
              spec: currentSpec,
            };
          },
        }),
        discoverConnectorsForBlueprint: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.discoverConnectorsForBlueprint,
          inputSchema: discoverConnectorsForBlueprintInputSchema,
          execute: async (input) => discoverConnectorsForBlueprint(auth, {
            ...input,
            previousConnectors: (currentSpec!.taskBlueprint?.outcomes ?? [])
              .map((outcome) => outcome.selectedConnector)
              .filter((connector): connector is string => Boolean(connector)),
          }),
        }),
        pickConnectorApp: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.pickConnectorApp,
          inputSchema: pickConnectorAppInputSchema,
        }),
        presentReplyOptions: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.presentReplyOptions,
          inputSchema: presentReplyOptionsInputSchema,
        }),
        listTriggers: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.listTriggers,
          inputSchema: listTriggersInputSchema,
          execute: async ({ toolkit }) => {
            const resolved = await resolveToolkitSlug(toolkit);
            const triggers = await listComposioTriggerTypes(resolved);
            return { toolkit: resolved, triggers };
          },
        }),
        listActions: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.listActions,
          inputSchema: listActionsInputSchema,
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
          description: CONDUCTOR_TOOL_DESCRIPTIONS.discoverBindings,
          inputSchema: discoverBindingsInputSchema,
          execute: async (input) => discoverOutcomeBindings(input.toolkit, input.outcomes),
        }),
        connectToolkit: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.connectToolkit,
          inputSchema: connectToolkitInputSchema,
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
        listWorkspaceConnectors: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.listWorkspaceConnectors,
          inputSchema: listWorkspaceConnectorsInputSchema,
          execute: async () => {
            const connectors = await listWorkspaceConnectors(auth);
            return {
              connectors: connectors.map((connector) => ({
                slug: connector.slug,
                name: connector.name,
                connected: Boolean(connector.connected),
              })),
            };
          },
        }),
        askQuestion: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.askQuestion,
          inputSchema: askQuestionInputSchema,
        }),
        confirmOutcomeBrief: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.confirmOutcomeBrief,
          inputSchema: confirmOutcomeBriefInputSchema,
        }),
        compileLoop: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.compileLoop,
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
          description: CONDUCTOR_TOOL_DESCRIPTIONS.testRunLoop,
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
          description: CONDUCTOR_TOOL_DESCRIPTIONS.activateLoop,
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
      originalMessages: chatMessages,
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
