import { Router, type Response } from "express";
import { z } from "zod";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";

import { prepareConductorChatMessagesForEventLog } from "../../../loops/conductor-chat.js";
import { eventPayloadHash, interruptionEventsFromUiMessages, projectChatMessages } from "../../../loops/build-events.js";
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
  presentAgentTeamInputSchema,
  presentReplyOptionsInputSchema,
  setBindingConfigInputSchema,
  testRunLoopInputSchema,
} from "../../../loops/conductor-tools.js";
import { computeOutcomeBriefHash } from "../../../loops/outcome-brief.js";
import { normalizeAgentTeam } from "../../../loops/present-agent-team.js";
import { discoverOutcomeBindings, extractConfigurableFields, resolveConfigurableFieldOptions, validateConfigAgainstSchema } from "../../../loops/binding-discovery.js";
import { discoverConnectorsForBlueprint } from "../../../loops/connector-discovery.js";
import { executeLoopTestRun } from "../../../loops/test-run.js";
import {
  activateLoop,
  archiveLoop,
  compileLoop,
  createLoopInWorkspace,
  recordLoopTestResult,
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
import { getLoopRun, getPendingApprovalForRun, listLoopRunSteps, getBuildChatMessages, saveBuildChatMessages, getLoopBuildMeta, getRunChatMessages, getLatestPassingTestRunForPlan, getLoopEventTriggerStatus, getLatestBuildState, commitLoopBuildArtifact, appendBuildEvents, getBuildEvents } from "../../../loops/store.js";
import { projectLoopSpec, userFacingStageForPhase, BuildStateError } from "../../../loops/build-state.js";
import {
  deriveIntentAndBlueprint,
  deriveBindingArtifact,
  bindingEvidenceFromMessages,
  interpretBindingDiscovery,
  interpretCompletedIntent,
  interpretConnectorSelections,
  interpretReviewConfirmation,
  connectorSelectionEvidence,
  type InterpretedBindingDiscovery,
  type InterpretedTriggerList,
  type InterpretedBindingConfig,
} from "../../../loops/build-event-interpreter.js";
import { composioWebhookDeliveryUrl, isLocalWebhookUrl } from "../../../integrations/composio/webhook-subscription.js";
import { deriveLoopNameFromPrompt } from "../../../loops/loop-name.js";
import { resolveActivationGap } from "../../../loops/activation-status.js";
import {
  CONDUCTOR_TOOL_DESCRIPTIONS,
} from "../../../loops/conductor-chat-prompts.js";
import { buildConductorSystemPrompt } from "../../../loops/planning-agent.js";
import { getStreamingLanguageModel } from "../../../providers/ai/streaming/language-model.js";
import { getToolkitConnectionStatus, listWorkspaceConnectors, startToolkitAuthorization } from "../../../integrations/composio/accounts.js";
import { listComposioTriggerTypes, scoreTriggerSlugMatch } from "../../../integrations/composio/triggers.js";
import { resolveToolkitSlug } from "../../../integrations/composio/auth.js";
import { getAllTools } from "../../../integrations/composio/tools.js";
import { getWorkspace } from "../../../services/workspace/index.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();
router.use(authMiddleware);
router.use(workspaceMiddleware);

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof BuildStateError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
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
    const buildState = await getLatestBuildState(req.authContext!, loopId);
    const spec = buildState ? projectLoopSpec(buildState) : null;
    const chatMessages = await getBuildChatMessages(req.authContext!, loopId);
    const buildChat = await getLoopBuildMeta(req.authContext!, loopId);
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
      buildState,
      buildProgress: buildState ? {
        internalPhase: buildState.buildPhase,
        stage: userFacingStageForPhase(buildState.buildPhase),
      } : null,
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
    const { compiledPlanId, confirmedByUser } = z.object({
      compiledPlanId: z.string().uuid(), confirmedByUser: z.literal(true),
    }).parse(req.body ?? {});
    const result = await activateLoop(req.authContext!, loopId, compiledPlanId, confirmedByUser);
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
    const messages = await saveBuildChatMessages(auth, loopId, body.messages);
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

    const incomingMessages = prepareConductorChatMessagesForEventLog(body.messages);
    await saveBuildChatMessages(auth, loopId, incomingMessages);
    let buildEvents = await getBuildEvents(auth, loopId);
    let chatMessages = projectChatMessages(buildEvents);

    let currentBuildState = await getLatestBuildState(auth, loopId);
    if (!currentBuildState) {
      res.status(400).json({ error: "Loop build state not found" });
      return;
    }
    let currentSpec = projectLoopSpec(currentBuildState);

    const [workspace, initialConnectors, buildMeta] = await Promise.all([
      getWorkspace(auth, loop.workspaceId),
      listWorkspaceConnectors(auth),
      getLoopBuildMeta(auth, loopId),
    ]);
    let latestCompiledPlanId = buildMeta?.compiledPlanId ?? null;
    let latestTestRunPass: { planId: string; runId: string } | null = null;
    if (latestCompiledPlanId) {
      const storedPass = await getLatestPassingTestRunForPlan(auth, loopId, latestCompiledPlanId);
      if (storedPass) {
        latestTestRunPass = { planId: latestCompiledPlanId, runId: storedPass.runId };
      }
    }

    const buildCurrentSystemPrompt = () => buildConductorSystemPrompt({
      workspaceName: workspace.name,
      spec: currentSpec!,
      confirmationHash: currentBuildState!.artifacts.bindings?.artifactHash ?? computeOutcomeBriefHash(currentSpec!),
      connectedToolkits: initialConnectors.map((t) => ({
        slug: t.slug,
        name: t.name,
        connected: Boolean(t.connected),
      })),
      buildPhase: currentBuildState!.buildPhase,
    });

    const recordArtifact = async (phase: Parameters<typeof commitLoopBuildArtifact>[0]["phase"], artifact: unknown, expectedParentHash?: string) => {
      const committed = await commitLoopBuildArtifact({ auth, loopId, phase, artifact, expectedParentHash });
      currentBuildState = committed.state;
      currentSpec = projectLoopSpec(committed.state);
      latestCompiledPlanId = null;
      latestTestRunPass = null;
      const { getMissingSlots } = await import("../../../loops/patch.js");
      return {
        ok: true as const, ...committed, state: undefined,
        spec: currentSpec,
        missingSlots: getMissingSlots(currentSpec),
      };
    };

    const interpretedIntent = interpretCompletedIntent({
      state: currentBuildState,
      spec: currentSpec,
      messages: buildEvents,
      connectedToolkits: initialConnectors,
    });
    if (interpretedIntent) {
      await recordArtifact("intent", interpretedIntent.intent);
      await recordArtifact("blueprint", interpretedIntent.blueprint, currentBuildState.artifacts.intent!.artifactHash);
    }
    const connectorSelectionsAreLive = async (
      artifact: { selections: Array<{ connector: string }> },
    ): Promise<boolean> => {
      const toolkits = [...new Set(artifact.selections.map((selection) => selection.connector.toLowerCase()))];
      const statuses = await Promise.all(toolkits.map((toolkit) => getToolkitConnectionStatus(auth, toolkit)));
      return statuses.every((connection) => connection.connected);
    };
    const interpretedConnectors = interpretConnectorSelections(currentBuildState, buildEvents);
    if (interpretedConnectors && await connectorSelectionsAreLive(interpretedConnectors)) {
      await recordArtifact("connectors", interpretedConnectors, currentBuildState.artifacts.blueprint!.artifactHash);
    }
    let preparedConnectorDiscovery: Awaited<ReturnType<typeof discoverConnectorsForBlueprint>> | null = null;
    const applyAutoResolvedConnectors = async (
      discovered: Awaited<ReturnType<typeof discoverConnectorsForBlueprint>>,
    ) => {
      if (discovered.autoResolved.length === 0) return;
      await appendBuildEvents(auth, loopId, discovered.autoResolved.map((selection) => ({
        eventKey: `connector-auto:${selection.outcomeId}:${selection.connector.toLowerCase()}`,
        type: "connector.auto_resolved" as const,
        payload: selection,
      })));
      buildEvents = await getBuildEvents(auth, loopId);
      chatMessages = projectChatMessages(buildEvents);
      const connectorArtifact = interpretConnectorSelections(currentBuildState!, buildEvents);
      if (connectorArtifact
        && currentBuildState!.buildPhase === "connectors"
        && await connectorSelectionsAreLive(connectorArtifact)) {
        await recordArtifact("connectors", connectorArtifact, currentBuildState!.artifacts.blueprint!.artifactHash);
      }
    };
    const priorConnectorSelections = connectorSelectionEvidence(buildEvents);
    if (currentBuildState.buildPhase === "connectors" && priorConnectorSelections.length > 0) {
      preparedConnectorDiscovery = await discoverConnectorsForBlueprint(auth, {
        outcomes: currentSpec.taskBlueprint?.outcomes ?? [],
        previousSelections: priorConnectorSelections,
        previousConnectors: (currentSpec.taskBlueprint?.outcomes ?? [])
          .map((outcome) => outcome.selectedConnector)
          .filter((connector): connector is string => Boolean(connector)),
      });
      await applyAutoResolvedConnectors(preparedConnectorDiscovery);
    }
    const interpretedBindings = interpretBindingDiscovery(currentBuildState, buildEvents);
    if (interpretedBindings) {
      await recordArtifact("bindings", interpretedBindings, currentBuildState.artifacts.connectors!.artifactHash);
    }
    const interpretedReview = interpretReviewConfirmation(currentBuildState, buildEvents);
    if (interpretedReview) {
      await recordArtifact("review", interpretedReview, currentBuildState.artifacts.bindings!.artifactHash);
    }
    const bindingEvidence = bindingEvidenceFromMessages(buildEvents);
    const bindingDiscoveries: InterpretedBindingDiscovery[] = [...bindingEvidence.discoveries];
    const triggerLists: InterpretedTriggerList[] = [...bindingEvidence.triggerLists];
    const bindingConfigs: InterpretedBindingConfig[] = [...bindingEvidence.bindingConfigs];
    const recordBindingsWhenComplete = async () => {
      const artifact = deriveBindingArtifact(currentBuildState!, bindingDiscoveries, triggerLists, bindingConfigs);
      if (!artifact || currentBuildState!.buildPhase !== "bindings") return;
      await recordArtifact("bindings", artifact, currentBuildState!.artifacts.connectors!.artifactHash);
    };

    const activeToolsForPhase = () => {
      switch (currentBuildState!.buildPhase) {
        case "intent": return ["analyzeIntent", "askQuestion"];
        case "blueprint": return [];
        case "connectors": return ["discoverConnectorsForBlueprint", "pickConnectorApp", "listWorkspaceConnectors", "connectToolkit"];
        case "bindings": return ["listTriggers", "listActions", "discoverBindings", "askQuestion", "setBindingConfig"];
        case "review": return ["presentAgentTeam", "confirmOutcomeBrief"];
        case "compile": return ["compileLoop"];
        case "test": return ["testRunLoop"];
        case "activation": return ["presentReplyOptions", "activateLoop"];
      }
    };
    const requirePhase = (...allowed: Array<NonNullable<typeof currentBuildState>["buildPhase"]>) => {
      if (!allowed.includes(currentBuildState!.buildPhase)) {
        throw new BuildStateError("BUILD_INVALID_TRANSITION", `Tool is not authorized during ${currentBuildState!.buildPhase}`);
      }
    };

    const result = streamText({
      model: getStreamingLanguageModel("conductor", { userId: auth.userId }),
      stopWhen: stepCountIs(16),
      system: buildCurrentSystemPrompt(),
      prepareStep: () => ({ system: buildCurrentSystemPrompt(), activeTools: activeToolsForPhase() as never[] }),
      messages: await convertToModelMessages(chatMessages),
      tools: {
        analyzeIntent: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent,
          inputSchema: analyzeIntentInputSchema,
          execute: async (analysis) => {
            requirePhase("intent");
            if (analysis.questions.length === 0) {
              const interpreted = deriveIntentAndBlueprint({
                spec: currentSpec!,
                analysis,
                answers: new Map(),
                connectedToolkits: initialConnectors,
              });
              if (interpreted) {
                await recordArtifact("intent", interpreted.intent);
                await recordArtifact("blueprint", interpreted.blueprint, currentBuildState!.artifacts.intent!.artifactHash);
              }
            }
            return { ok: true, analysis };
          },
        }),
        discoverConnectorsForBlueprint: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.discoverConnectorsForBlueprint,
          inputSchema: discoverConnectorsForBlueprintInputSchema,
          execute: async (input) => {
            requirePhase("connectors");
            const discovered = preparedConnectorDiscovery ?? await discoverConnectorsForBlueprint(auth, {
                ...input,
                previousSelections: connectorSelectionEvidence(buildEvents),
                previousConnectors: (currentSpec!.taskBlueprint?.outcomes ?? [])
                  .map((outcome) => outcome.selectedConnector)
                  .filter((connector): connector is string => Boolean(connector)),
              });
            preparedConnectorDiscovery = null;
            await applyAutoResolvedConnectors(discovered);
            return discovered;
          },
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
            requirePhase("bindings");
            const resolved = await resolveToolkitSlug(toolkit);
            const rawTriggers = (await listComposioTriggerTypes(resolved)).map((trigger) => ({
              ...trigger,
              configurableFields: extractConfigurableFields(trigger.config ?? {}),
            }));
            const uniqueFields = [...new Map(rawTriggers.flatMap((trigger) => trigger.configurableFields)
              .map((field) => [field.key, field])).values()];
            const resolvedFields = await resolveConfigurableFieldOptions(auth, resolved, uniqueFields);
            const optionsByKey = new Map(resolvedFields.map((field) => [field.key, field.options]));
            const triggers = rawTriggers.map((trigger) => ({
              ...trigger,
              configurableFields: trigger.configurableFields.map((field) => ({
                ...field,
                options: optionsByKey.get(field.key) ?? field.options,
              })).filter((field) => !/(?:ids?|_ids?)$/i.test(field.key) || field.options.length > 0),
            }));
            triggerLists.push({ toolkit: resolved, triggers });
            await recordBindingsWhenComplete();
            return { toolkit: resolved, triggers, spec: currentSpec };
          },
        }),
        listActions: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.listActions,
          inputSchema: listActionsInputSchema,
          execute: async ({ toolkit }) => {
            requirePhase("bindings");
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
          execute: async (input) => {
            requirePhase("bindings");
            const selected = new Set((currentBuildState!.artifacts.connectors?.artifact as { selections?: Array<{ connector: string }> })
              ?.selections?.map((row) => row.connector.toLowerCase()) ?? []);
            if (!selected.has(input.toolkit.toLowerCase())) {
              throw new BuildStateError("BUILD_UNSELECTED_CONNECTOR", `Cannot discover bindings for unselected connector ${input.toolkit}`);
            }
            const discovered = await discoverOutcomeBindings(input.toolkit, input.outcomes);
            bindingDiscoveries.push({
              toolkit: discovered.toolkit,
              suggestedBindings: discovered.suggestedBindings,
            });
            await recordBindingsWhenComplete();
            return { ...discovered, spec: currentSpec };
          },
        }),
        setBindingConfig: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.setBindingConfig,
          inputSchema: setBindingConfigInputSchema,
          execute: async (input) => {
            requirePhase("bindings");
            const blueprint = currentSpec!.taskBlueprint?.outcomes.find((outcome) => outcome.id === input.outcomeId);
            if (!blueprint || blueprint.role !== "trigger") {
              throw new BuildStateError("BUILD_INVALID_TRANSITION", "Trigger configuration must target the trigger outcome");
            }
            if (blueprint.selectedConnector?.toLowerCase() !== input.connector.toLowerCase()) {
              throw new BuildStateError("BUILD_UNSELECTED_CONNECTOR", `Cannot configure unselected connector ${input.connector}`);
            }
            const candidates = triggerLists.flatMap((list) => list.toolkit.toLowerCase() === input.connector.toLowerCase()
              ? list.triggers : []);
            const selected = candidates.slice().sort((left, right) =>
              scoreTriggerSlugMatch(blueprint.description, String(right.slug ?? ""), String(right.name ?? ""))
              - scoreTriggerSlugMatch(blueprint.description, String(left.slug ?? ""), String(left.name ?? "")))[0];
            if (!selected) throw new BuildStateError("BUILD_INVALID_TRANSITION", "List triggers before setting trigger configuration");
            const schema = selected.config && typeof selected.config === "object" && !Array.isArray(selected.config)
              ? selected.config as Record<string, unknown> : {};
            const surfacedFields = Array.isArray(selected.configurableFields)
              ? selected.configurableFields.filter((field): field is { key: string } =>
                Boolean(field && typeof field === "object" && "key" in field && typeof field.key === "string"))
              : extractConfigurableFields(schema);
            const allowed = new Set(surfacedFields.map((field) => field.key));
            const unsupported = Object.keys(input.config).find((key) => !allowed.has(key));
            if (unsupported) throw new BuildStateError("BUILD_INVALID_TRANSITION", `Unsupported trigger configuration field ${unsupported}`);
            const validation = validateConfigAgainstSchema(schema, input.config);
            if (!validation.ok) throw new BuildStateError("BUILD_INVALID_TRANSITION", validation.error);
            const saved = { outcomeId: input.outcomeId, connector: input.connector, config: input.config };
            const priorIndex = bindingConfigs.findIndex((entry) => entry.outcomeId === input.outcomeId);
            if (priorIndex >= 0) bindingConfigs[priorIndex] = saved;
            else bindingConfigs.push(saved);
            await appendBuildEvents(auth, loopId, [{
              eventKey: `binding-config:${input.outcomeId}:${eventPayloadHash(input.config)}`,
              type: "binding.config_set",
              payload: saved,
            }]);
            await recordBindingsWhenComplete();
            return { ok: true as const, ...saved };
          },
        }),
        connectToolkit: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.connectToolkit,
          inputSchema: connectToolkitInputSchema,
          execute: async ({ toolkit, callbackUrl }) => {
            requirePhase("connectors");
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
            requirePhase("connectors");
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
        presentAgentTeam: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.presentAgentTeam,
          inputSchema: presentAgentTeamInputSchema,
          execute: async (input) => {
            requirePhase("review");
            return normalizeAgentTeam(input, currentSpec!);
          },
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
            currentBuildState = await getLatestBuildState(auth, loopId);
            if (currentBuildState) currentSpec = projectLoopSpec(currentBuildState);
            return {
              ok: true as const,
              plan: {
                id: compiled.plan!.id,
                revision: compiled.plan!.revision,
                toolCount: compiled.plan!.toolCatalog.length,
                profile: compiled.plan!.profile,
              },
              spec: currentSpec,
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
              const recorded = await recordLoopTestResult(auth, loopId, {
                compiledPlanId: planId, runId: result.runId, passed: true,
              });
              currentBuildState = recorded.state;
              currentSpec = projectLoopSpec(recorded.state);
            }
            return result;
          },
        }),
        activateLoop: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.activateLoop,
          inputSchema: activateLoopInputSchema,
          execute: async ({ compiledPlanId, confirmedByUser }) => {
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
            const activated = await activateLoop(auth, loopId, planId, confirmedByUser);
            currentBuildState = await getLatestBuildState(auth, loopId);
            if (currentBuildState) currentSpec = projectLoopSpec(currentBuildState);
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
        try {
          if (isAborted) await appendBuildEvents(auth, loopId, interruptionEventsFromUiMessages(messages));
          await saveBuildChatMessages(auth, loopId, messages);
        } catch (error) {
          console.error(`[loops/chat] failed to persist conductor transcript${isAborted ? " after abort" : ""}:`, error);
        }
      },
    });
  } catch (error) {
    sendError(res, error, "Failed to stream Conductor chat");
  }
});

export default router;
