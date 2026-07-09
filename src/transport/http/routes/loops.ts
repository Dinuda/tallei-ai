import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createUIMessageStream,
  MissingToolResultsError,
  pipeUIMessageStreamToResponse,
  type StopCondition,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";

import {
  isMissingToolResultsError,
  prepareConductorChatMessagesForEventLog,
  prepareConductorModelMessagesForStream,
} from "../../../loops/conductor-chat.js";
import { ensurePendingPickConnectorApp } from "../../../loops/conductor-pick-recovery.js";
import {
  countUncompletedUiToolRequests,
  derivePendingUiToolFromEvents,
  eventPayloadHash,
  eventsForConductorPhaseAttempt,
  hasCompletedConductorOperation,
  hasTerminalConductorPhaseResult,
  interruptionEventsForToolCallIds,
  interruptionEventsFromUiMessages,
  isTerminalConductorExecution,
  makeConductorPhaseTurnEvent,
  makeConductorToolCompletedEvent,
  projectChatMessages,
  getLatestConductorOperationAttempt,
} from "../../../loops/build-events.js";
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
  readConductorExecutionMetadata,
  isConductorBuildPhase,
  isRecoverableConductorExecution,
  resolveBindingsInputSchema,
  testRunLoopInputSchema,
  type ConductorExecutionMetadata,
  type PhaseExecutionContract,
} from "../../../loops/conductor-tools.js";
import { computeOutcomeBriefHash } from "../../../loops/outcome-brief.js";
import { normalizeAgentTeam } from "../../../loops/present-agent-team.js";
import { discoverOutcomeBindings, extractConfigurableFields, resolveConfigurableFieldOptions } from "../../../loops/binding-discovery.js";
import {
  prepareBindingResolution,
  describeBindingResolutionError,
  filterBindingResolutionAnswers,
  resolvePreparedBindings,
  findNoFeasibleActionDiagnostics,
  pinnedTriggerSlugFromInput,
  type BindingResolverAnswer,
  type BindingResolverAction,
  type BindingResolverTrigger,
} from "../../../loops/binding-resolver.js";
import { enrichBindingActionCandidate } from "@tallei/composio-tools/schema-contract.js";
import { getTriggerFieldNamesForFeasibility } from "@tallei/composio-tools/trigger-known-fields.js";
import { discoverConnectorsForBlueprint } from "../../../loops/connector-discovery.js";
import { executeLoopTestRun } from "../../../loops/test-run.js";
import {
  activateLoop,
  archiveLoop,
  compileLoop,
  createLoopInWorkspace,
  recoverLoopBuildToCompile,
  recordLoopTestResult,
  reconcileLoopBuildContinuity,
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
import { getLoopRun, getPendingApprovalForRun, listLoopRunSteps, saveBuildChatMessages, getLoopBuildMeta, getRunChatMessages, getLatestPassingTestRunForPlan, getLoopEventTriggerStatus, commitLoopBuildArtifact, appendBuildEvents, getBuildEvents, projectLoopBuildFromEvents, buildLoopBuildMetaFromProjection } from "../../../loops/store.js";
import type { LoopBuildProjection } from "../../../loops/build-state-projection.js";
import {
  BUILD_ERROR_CODES,
  BUILD_PHASES,
  projectLoopSpec,
  userFacingStageForPhase,
  BuildPhase,
  BuildStateError,
  testArtifactSchema,
} from "../../../loops/build-state.js";
import {
  deriveIntentAndBlueprint,
  bindingActionOutcomesForToolkit,
  bindingEvidenceFromMessages,
  completedToolEvents,
  interpretBindingDiscovery,
  interpretCompletedIntent,
  interpretConnectorSelections,
  interpretReviewConfirmation,
  connectorSelectionEvidence,
  type InterpretedTriggerList,
  type BindingDiagnostic,
} from "../../../loops/build-event-interpreter.js";
import { deriveBuildPhaseProgress } from "../../../loops/build-phase-progress.js";
import { isActivationConfirmationReply } from "@tallei/shared/conductor-activation-confirm.js";
import { composioWebhookDeliveryUrl, isLocalWebhookUrl } from "../../../integrations/composio/webhook-subscription.js";
import { deriveLoopNameFromPrompt } from "../../../loops/loop-name.js";
import { resolveActivationGap } from "../../../loops/activation-status.js";
import { resolveConductorTurnResolution } from "../../../loops/conductor-turn-resolution.js";
import {
  formatConductorStreamError,
} from "../../../loops/conductor-stream-diagnostics.js";
import { finalizeConductorTurnBookkeeping } from "../../../loops/conductor-turn-finalize.js";
import {
  CONDUCTOR_SESSION_MAX_AUTO_CONTINUATIONS,
  applyUiToolAnswerToMessages,
  makePhaseHandoffConsumedEvent,
  mapContinuationIntentToStopReason,
  phaseHandoffConsumePayloadFromTurn,
  shouldAutoContinueConductorSession,
} from "../../../loops/conductor-session-loop.js";
import {
  buildMandatoryNextToolInstruction,
  CONDUCTOR_TOOL_DESCRIPTIONS,
} from "@tallei/conductor-tools/descriptions.js";
import { conductorStepLimitForPhase } from "@tallei/shared/conductor-turn-budget.js";
import {
  buildConductorSessionUsage,
  emptyConductorChatUsage,
  finalizeConductorChatUsage,
  sumConductorChatUsage,
  sumConductorUsageFromMessages,
  usageFromLanguageModelStep,
} from "../../../loops/conductor-usage.js";
import { buildConductorSystemPrompt } from "../../../loops/planning-agent.js";
import { config } from "../../../config/index.js";
import { modelGateway } from "../../../model/index.js";
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    const requestStarted = performance.now();
    const timings: Record<string, number> = {};
    const mark = (label: string, startedAt: number) => {
      timings[label] = performance.now() - startedAt;
    };

    const { loopId } = loopIdSchema.parse(req.params);
    const loopStarted = performance.now();
    const loop = await getLoop(req.authContext!, loopId);
    mark("getLoop", loopStarted);
    if (!loop) {
      res.status(404).json({ error: "Loop not found" });
      return;
    }
    const projectionStarted = performance.now();
    let loopBuild = await import("../../../loops/store.js").then((m) => m.getLoopBuildProjection(req.authContext!, loopId, {
      connectedToolkits: [],
      loopStatus: loop.status,
    }));
    // Heal stuck connectors sessions on load: if the phase needs pickConnectorApp
    // but the transcript has no open picker, inject one so refresh recovers without
    // waiting for the model to call the tool.
    if (loopBuild.state?.buildPhase === "connectors"
      && loopBuild.phaseProgress?.nextTool === "pickConnectorApp"
      && !loopBuild.pendingUiTool) {
      const healed = ensurePendingPickConnectorApp({
        messages: loopBuild.chatMessages,
        state: loopBuild.state,
        pendingUiTool: loopBuild.pendingUiTool,
        nextTool: loopBuild.phaseProgress.nextTool,
        phase: "connectors",
      });
      if (healed.injected) {
        await saveBuildChatMessages(req.authContext!, loopId, healed.messages);
        loopBuild = await import("../../../loops/store.js").then((m) => m.getLoopBuildProjection(req.authContext!, loopId, {
          connectedToolkits: [],
          loopStatus: loop.status,
        }));
      }
    }
    mark("projection", projectionStarted);
    const buildChat = buildLoopBuildMetaFromProjection(loopBuild);
    const buildState = loopBuild.state;
    const spec = loopBuild.spec;
    const chatMessages = loopBuild.chatMessages;
    const missingSlotsStarted = performance.now();
    const { getMissingSlots } = await import("../../../loops/patch.js");
    const missingSlots = spec ? getMissingSlots(spec) : [];
    mark("missingSlots", missingSlotsStarted);
    const eventTriggerStarted = performance.now();
    const eventTrigger = await getLoopEventTriggerStatus(loopId);
    mark("eventTrigger", eventTriggerStarted);
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
    timings.total = performance.now() - requestStarted;
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[loops/get:${loopId}] timings`, timings);
    }
    res.json({
      loop,
      spec,
      buildState,
      buildProgress: buildState ? {
        internalPhase: buildState.buildPhase,
        stage: userFacingStageForPhase(buildState.buildPhase),
        phaseProgress: loopBuild.phaseProgress,
        latestPhaseTurn: loopBuild.latestPhaseTurn,
        consumedHandoffIds: loopBuild.consumedHandoffIds,
        continuationIntent: loopBuild.continuationIntent,
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

const UI_TOOL_ANSWER_TOOLS = [
  "askQuestion",
  "pickConnectorApp",
  "confirmOutcomeBrief",
  "presentReplyOptions",
] as const;

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

    const connectorToolkitStatus = async () => {
      const connectors = await listWorkspaceConnectors(auth);
      return connectors.map((toolkit) => ({
        slug: toolkit.slug,
        connected: Boolean(toolkit.connected),
      }));
    };

    let buildEvents = await getBuildEvents(auth, loopId);
    let buildProjection: LoopBuildProjection = projectLoopBuildFromEvents(buildEvents, {
      connectedToolkits: await connectorToolkitStatus(),
      loopStatus: loop.status,
    });
    let chatMessages = buildProjection.chatMessages;
    let currentBuildState = buildProjection.state;
    if (!currentBuildState) {
      res.status(400).json({ error: "Loop build state not found" });
      return;
    }
    const continuity = await reconcileLoopBuildContinuity(auth, loopId);
    if (continuity.recovered) {
      buildEvents = await getBuildEvents(auth, loopId);
      buildProjection = projectLoopBuildFromEvents(buildEvents, {
        connectedToolkits: await connectorToolkitStatus(),
        loopStatus: loop.status,
      });
      currentBuildState = buildProjection.state!;
      chatMessages = buildProjection.chatMessages;
    }

    let currentSpec = projectLoopSpec(currentBuildState);

    let currentLoopStatus = loop.status;

    const refreshBuildProjection = async (
      context: { effectivePhase?: BuildPhase; resumeTool?: string | null } = {},
    ) => {
      const freshLoop = await getLoop(auth, loopId);
      if (freshLoop?.status) currentLoopStatus = freshLoop.status;
      buildEvents = await getBuildEvents(auth, loopId);
      buildProjection = projectLoopBuildFromEvents(buildEvents, {
        connectedToolkits: await connectorToolkitStatus(),
        effectivePhase: context.effectivePhase,
        resumeTool: context.resumeTool ?? null,
        loopStatus: currentLoopStatus,
      });
      if (buildProjection.state) {
        currentBuildState = buildProjection.state;
        currentSpec = buildProjection.spec ?? projectLoopSpec(buildProjection.state);
      }
      chatMessages = buildProjection.chatMessages;
      return buildProjection;
    };
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

    const buildCurrentSystemPrompt = () => {
      const phaseProgress = deriveBuildPhaseProgress(currentBuildState!, buildEvents, {
        effectivePhase: requestPhaseContract.phase,
        connectedToolkits: initialConnectors.map((t) => ({
          slug: t.slug,
          connected: Boolean(t.connected),
        })),
        loopStatus: currentLoopStatus,
      });
      return buildConductorSystemPrompt({
        workspaceName: workspace.name,
        spec: currentSpec!,
        confirmationHash: currentBuildState!.artifacts.bindings?.artifactHash ?? computeOutcomeBriefHash(currentSpec!),
        connectedToolkits: initialConnectors.map((t) => ({
          slug: t.slug,
          name: t.name,
          connected: Boolean(t.connected),
        })),
        buildPhase: requestPhaseContract.phase,
        phaseProgress,
        phaseContract: requestPhaseContract,
        resumeTool: null,
      });
    };

    const recordArtifact = async (phase: Parameters<typeof commitLoopBuildArtifact>[0]["phase"], artifact: unknown, expectedParentHash?: string) => {
      const committed = await commitLoopBuildArtifact({ auth, loopId, phase, artifact, expectedParentHash });
      await refreshBuildProjection();
      latestCompiledPlanId = null;
      latestTestRunPass = null;
      const { getMissingSlots } = await import("../../../loops/patch.js");
      return {
        ok: true as const, ...committed, state: undefined,
        spec: currentSpec,
        missingSlots: getMissingSlots(currentSpec!),
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
      await refreshBuildProjection();
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
    const triggerLists: InterpretedTriggerList[] = [...bindingEvidence.triggerLists];
    const persistBindingDiagnostics = async (diagnostics: BindingDiagnostic[]) => {
      if (diagnostics.length === 0) return;
      await appendBuildEvents(auth, loopId, [{
        eventKey: `binding-diagnostic:${eventPayloadHash(diagnostics)}`,
        type: "binding.diagnostic",
        payload: { diagnostics },
      }]);
    };
    const parentArtifactHashForPhase = (phase: BuildPhase): string => {
      const phaseIndex = BUILD_PHASES.indexOf(phase);
      if (phaseIndex <= 0) return "root";
      const parent = currentBuildState!.artifacts[BUILD_PHASES[phaseIndex - 1]];
      return parent?.artifactHash ?? "root";
    };
    const toolsForBuildPhase = (phase: BuildPhase) => {
      switch (phase) {
        case "intent": return ["analyzeIntent", "askQuestion"];
        case "blueprint": return [];
        case "connectors": return ["discoverConnectorsForBlueprint", "pickConnectorApp", "listWorkspaceConnectors", "connectToolkit"];
        case "bindings": return ["listTriggers", "listActions", "discoverBindings", "askQuestion", "resolveBindings"];
        case "review": return ["presentAgentTeam", "confirmOutcomeBrief"];
        case "compile": return ["compileLoop", "listTriggers", "listActions", "discoverBindings", "askQuestion", "resolveBindings", "listWorkspaceConnectors", "connectToolkit"];
        case "test": return ["testRunLoop"];
        case "activation": return ["presentReplyOptions", "activateLoop"];
      }
    };
    let requestStartPhase = currentBuildState.buildPhase;
    let requestStartParentArtifactHash = parentArtifactHashForPhase(requestStartPhase);
    let requestStepLimit = conductorStepLimitForPhase(requestStartPhase);
    let requestPhaseContract: PhaseExecutionContract = Object.freeze({
      phase: requestStartPhase,
      parentArtifactHash: requestStartParentArtifactHash,
      allowedTools: Object.freeze([] as string[]),
      nextTool: null,
      compiledPlanId: latestCompiledPlanId,
      revision: `${requestStartPhase}:${requestStartParentArtifactHash}`,
    });
    let lastToolExecution: ConductorExecutionMetadata | null = null;
    let requestContractSuperseded = false;
    let turnStepCount = 0;
    let turnStreamError: string | null = null;
    let turnStreamStartedAt = 0;
    const turnStepTimingsMs: number[] = [];
    const inTurnOperationKeys = new Set<string>();
    const rebuildPhaseContract = () => {
      if (!currentBuildState) return;
      requestStartPhase = currentBuildState.buildPhase;
      requestStartParentArtifactHash = parentArtifactHashForPhase(requestStartPhase);
      requestStepLimit = conductorStepLimitForPhase(requestStartPhase);
      const requestPhaseProgress = deriveBuildPhaseProgress(currentBuildState, buildEvents, {
        effectivePhase: requestStartPhase,
        connectedToolkits: initialConnectors.map((toolkit) => ({
          slug: toolkit.slug,
          connected: Boolean(toolkit.connected),
        })),
        loopStatus: currentLoopStatus,
      });
      const requestAllowedTools = requestPhaseProgress.allowedTools.length > 0
        ? requestPhaseProgress.allowedTools
        : requestPhaseProgress.terminal
          ? []
          : requestPhaseProgress.nextTool
            ? [requestPhaseProgress.nextTool]
            : toolsForBuildPhase(requestStartPhase);
      requestPhaseContract = Object.freeze({
        phase: requestStartPhase,
        parentArtifactHash: requestStartParentArtifactHash,
        allowedTools: Object.freeze([...requestAllowedTools]),
        nextTool: requestPhaseProgress.nextTool,
        compiledPlanId: latestCompiledPlanId,
        revision: `${requestStartPhase}:${requestStartParentArtifactHash}`,
      });
      requestContractSuperseded = false;
      lastToolExecution = null;
      inTurnOperationKeys.clear();
      turnStepCount = 0;
    };
    rebuildPhaseContract();
    const resolveLivePhaseProgress = () => deriveBuildPhaseProgress(currentBuildState!, buildEvents, {
      effectivePhase: requestPhaseContract.phase,
      connectedToolkits: initialConnectors.map((toolkit) => ({
        slug: toolkit.slug,
        connected: Boolean(toolkit.connected),
      })),
      loopStatus: currentLoopStatus,
    });
    const resolveLiveAuthorizedTools = (): string[] => {
      const live = resolveLivePhaseProgress();
      if (live.allowedTools.length > 0) return [...live.allowedTools];
      if (live.terminal) return [];
      if (live.nextTool) return [live.nextTool];
      return [];
    };
    const persistToolExecution = async (toolName: string, input: unknown, output: unknown) => {
      const metadata = readConductorExecutionMetadata(output);
      if (!metadata) return;
      inTurnOperationKeys.add(metadata.operationKey);
      turnStepCount += 1;
      lastToolExecution = metadata;
      await appendBuildEvents(auth, loopId, [
        makeConductorToolCompletedEvent({
          toolName,
          input,
          output: output as Record<string, unknown>,
        }),
      ]);
      await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
    };
    const beginToolExecution = (
      toolName: string,
      target: string,
      options?: { historicalDedup?: boolean },
    ) => {
      const phaseBefore = currentBuildState!.buildPhase;
      const parentArtifactHash = parentArtifactHashForPhase(phaseBefore);
      const operationKey = `${phaseBefore}:${parentArtifactHash}:${toolName}:${target}`;
      const authorizedTools = resolveLiveAuthorizedTools();
      const contractError = phaseBefore !== requestPhaseContract.phase
        || parentArtifactHash !== requestPhaseContract.parentArtifactHash
        ? `The ${requestPhaseContract.phase} phase changed before ${toolName} could run.`
        : !authorizedTools.includes(toolName)
          ? `${toolName} is not authorized during the ${requestPhaseContract.phase} phase.`
          : undefined;
      if (contractError) {
        return { duplicate: true as const, operationKey, phaseBefore, parentArtifactHash, contractError };
      }
      const lookup = { operationKey, parentArtifactHash };
      const attemptEvents = eventsForConductorPhaseAttempt(buildEvents, { phase: phaseBefore, parentArtifactHash });
      const latestAttempt = getLatestConductorOperationAttempt(attemptEvents, lookup);
      const historicalDuplicate = (options?.historicalDedup !== false)
        && (
          hasCompletedConductorOperation(attemptEvents, lookup)
          || (latestAttempt?.metadata.ok === false && latestAttempt.metadata.retryAllowed === false)
        );
      if (inTurnOperationKeys.has(operationKey) || historicalDuplicate) {
        return { duplicate: true as const, operationKey, phaseBefore, parentArtifactHash };
      }
      return { duplicate: false as const, operationKey, phaseBefore, parentArtifactHash };
    };
    const finalizeToolExecution = async <T extends Record<string, unknown>>(
      toolName: string,
      input: unknown,
      start: { operationKey: string; phaseBefore: BuildPhase; parentArtifactHash: string },
      output: T,
    ) => {
      const parsed = readConductorExecutionMetadata(output);
      const phaseAfter = currentBuildState!.buildPhase;
      const ok = parsed?.ok ?? (typeof output.ok === "boolean" ? output.ok : true);
      const retryAllowed = parsed?.retryAllowed ?? (typeof output.retryAllowed === "boolean" ? output.retryAllowed : ok);
      const requiresUserInput = parsed?.requiresUserInput ?? (typeof output.requiresUserInput === "boolean" ? output.requiresUserInput : false);
      const invalidatedPhases = parsed?.invalidatedPhases
        ?? (Array.isArray(output.invalidatedPhases)
          ? output.invalidatedPhases.filter((phase): phase is BuildPhase => BUILD_PHASES.includes(phase as BuildPhase))
          : []);
      const error = parsed?.error ?? (typeof output.error === "string" ? output.error : undefined);
      const outputRecord = output as Record<string, unknown>;
      const recoverToPhase = parsed?.recoverToPhase
        ?? (isConductorBuildPhase(outputRecord.recoverToPhase) ? outputRecord.recoverToPhase : undefined);
      const recoverReason = parsed?.recoverReason
        ?? (typeof outputRecord.recoverReason === "string" ? outputRecord.recoverReason : undefined);
      const recoveryPhase = parsed?.recoveryPhase
        ?? (isConductorBuildPhase(outputRecord.recoveryPhase) ? outputRecord.recoveryPhase : recoverToPhase);
      const recoveryReason = parsed?.recoveryReason
        ?? (typeof outputRecord.recoveryReason === "string" ? outputRecord.recoveryReason : recoverReason);
      const resumeTool = parsed?.resumeTool
        ?? (typeof outputRecord.resumeTool === "string" ? outputRecord.resumeTool : undefined);
      const phaseCompleted = parsed?.phaseCompleted ?? phaseAfter !== start.phaseBefore;
      const stepsUsed = turnStepCount + 1;
      const outputTurnOutcome = typeof outputRecord.turnOutcome === "string"
        && ["progress", "phase_complete", "waiting_for_user", "blocked", "budget_exhausted", "build_complete"].includes(outputRecord.turnOutcome)
        ? outputRecord.turnOutcome as ConductorExecutionMetadata["turnOutcome"]
        : undefined;
      const outputContinuation = typeof outputRecord.continuation === "string"
        && ["continue_phase", "next_phase", "wait_for_user", "stop"].includes(outputRecord.continuation)
        ? outputRecord.continuation as ConductorExecutionMetadata["continuation"]
        : undefined;
      const turnOutcome: ConductorExecutionMetadata["turnOutcome"] = parsed?.turnOutcome
        ?? outputTurnOutcome
        ?? (requiresUserInput
          ? "waiting_for_user"
          : phaseCompleted
            ? ((start.phaseBefore === "activation" && ok) ? "build_complete" : "phase_complete")
            : (!ok && !retryAllowed)
              ? "blocked"
              : "progress");
      const continuation: ConductorExecutionMetadata["continuation"] = parsed?.continuation
        ?? outputContinuation
        ?? (turnOutcome === "waiting_for_user"
          ? "wait_for_user"
          : turnOutcome === "phase_complete"
            ? "next_phase"
            : turnOutcome === "build_complete" || turnOutcome === "blocked" || turnOutcome === "budget_exhausted"
              ? "stop"
              : "continue_phase");
      const nextPhase = parsed?.nextPhase
        ?? (continuation === "next_phase"
          ? (recoveryPhase ?? phaseAfter)
          : undefined);
      const outputPlan = outputRecord.plan && typeof outputRecord.plan === "object"
        ? outputRecord.plan as Record<string, unknown>
        : null;
      const compileArtifact = currentBuildState!.artifacts.compile?.artifact as { compiledPlanId?: unknown } | undefined;
      const compiledPlanId = parsed?.compiledPlanId
        ?? (typeof outputRecord.compiledPlanId === "string" ? outputRecord.compiledPlanId : undefined)
        ?? (typeof outputPlan?.id === "string" ? outputPlan.id : undefined)
        ?? (typeof compileArtifact?.compiledPlanId === "string" ? compileArtifact.compiledPlanId : undefined);
      const handoffId = parsed?.handoffId
        ?? (continuation === "next_phase" && nextPhase
          ? eventPayloadHash({ operationKey: start.operationKey, nextPhase, parentArtifactHash: start.parentArtifactHash })
          : undefined);
      const execution = {
        ok,
        operationKey: start.operationKey,
        phaseBefore: start.phaseBefore,
        phaseAfter,
        phaseCompleted,
        requiresUserInput,
        retryAllowed,
        parentArtifactHash: start.parentArtifactHash,
        invalidatedPhases,
        turnOutcome,
        continuation,
        stepsUsed,
        stepLimit: requestStepLimit,
        ...(error ? { error } : {}),
        ...(recoverToPhase ? { recoverToPhase } : {}),
        ...(recoverReason ? { recoverReason } : {}),
        ...(recoveryPhase ? { recoveryPhase } : {}),
        ...(recoveryReason ? { recoveryReason } : {}),
        ...(resumeTool ? { resumeTool } : {}),
        ...(nextPhase ? { nextPhase } : {}),
        ...(handoffId ? { handoffId } : {}),
        ...(compiledPlanId ? { compiledPlanId } : {}),
      } satisfies ConductorExecutionMetadata;
      const merged = { ...output, ...execution };
      await persistToolExecution(toolName, input, merged);
      return merged as T & ConductorExecutionMetadata;
    };
    const duplicateToolExecution = async (
      toolName: string,
      input: unknown,
      start: { operationKey: string; phaseBefore: BuildPhase; parentArtifactHash: string; contractError?: string },
      error: string,
    ) => finalizeToolExecution(toolName, input, start, {
      ok: false as const,
      error: start.contractError ?? error,
      retryAllowed: Boolean(start.contractError),
      requiresUserInput: false,
      invalidatedPhases: [],
    });
    const shouldStopConductorTurn: StopCondition<any> = ({ steps }) => {
      if (steps.length === 0) return false;
      if (requestContractSuperseded) return true;
      if (currentBuildState!.buildPhase !== requestStartPhase) return true;
      if (lastToolExecution
        && lastToolExecution.phaseBefore === requestStartPhase
        && lastToolExecution.parentArtifactHash === requestStartParentArtifactHash
        && isTerminalConductorExecution(lastToolExecution)) {
        return true;
      }
      if (resolveLiveAuthorizedTools().length === 0) return true;
      return hasTerminalConductorPhaseResult(eventsForConductorPhaseAttempt(buildEvents, {
        phase: requestStartPhase,
        parentArtifactHash: requestStartParentArtifactHash,
      }), {
        phase: requestStartPhase,
        parentArtifactHash: requestStartParentArtifactHash,
      });
    };

    const activeToolsForPhase = () => {
      if (requestContractSuperseded) return [];
      return resolveLiveAuthorizedTools();
    };
    const usageEmitRef: { emit?: () => void } = {};
    const streamErrorEmitRef: { emit?: (message: string) => void } = {};
    const startConductorStream = async (replaySourceMessages: UIMessage[]) => {
      turnStreamError = null;
      turnStreamStartedAt = performance.now();
      turnStepTimingsMs.length = 0;
      const pendingUiTool = derivePendingUiToolFromEvents(buildEvents);
      const preserveOpenUiToolCallIds = pendingUiTool
        ? new Set([pendingUiTool.toolCallId])
        : undefined;
      const prepared = await prepareConductorModelMessagesForStream(replaySourceMessages, {
        preserveOpenUiToolCallIds,
      });
      if (prepared.stats.repairedToolCallIds.length > 0) {
        console.warn(`[loops/chat:${loopId}] repaired ${prepared.stats.repairedToolCallIds.length} superseded tool call(s) for model replay`, {
          toolCallIds: prepared.stats.repairedToolCallIds,
          prunedMessageIds: prepared.stats.prunedMessageIds,
        });
      }
      const sessionUsageBase = sumConductorUsageFromMessages(replaySourceMessages);
      const turnUsageState = { current: emptyConductorChatUsage() };
      const resolvedConductorModel = modelGateway.resolveStreaming("conductor", { userId: auth.userId });
      return {
        ...prepared,
        sessionUsageBase,
        turnUsageState,
        modelId: resolvedConductorModel.modelId,
        surface: resolvedConductorModel.surface,
        result: streamText({
          model: resolvedConductorModel.model,
          ...(resolvedConductorModel.providerOptions
            ? { providerOptions: resolvedConductorModel.providerOptions }
            : {}),
          stopWhen: [shouldStopConductorTurn, stepCountIs(requestStepLimit)],
          system: buildCurrentSystemPrompt(),
          onError: ({ error }) => {
            turnStreamError = formatConductorStreamError(error);
            console.error(`[loops/chat:${loopId}] CONDUCTOR STREAM ERROR`, {
              loopId,
              phase: requestStartPhase,
              requiredNextTool: requestPhaseContract.nextTool,
              modelId: resolvedConductorModel.modelId,
              message: turnStreamError,
              error,
            });
            streamErrorEmitRef.emit?.(turnStreamError);
          },
          onStepFinish: ({ usage, toolCalls, finishReason, text }) => {
            if (turnStreamStartedAt > 0) {
              turnStepTimingsMs.push(Math.round(performance.now() - turnStreamStartedAt));
            }
            if (toolCalls.length === 0) {
              console.warn(`[loops/chat:${loopId}] step finished with no tool calls`, {
                loopId,
                phase: requestStartPhase,
                requiredNextTool: requestPhaseContract.nextTool,
                modelId: resolvedConductorModel.modelId,
                finishReason,
                textLength: text?.length ?? 0,
              });
            }
            turnUsageState.current = sumConductorChatUsage(
              turnUsageState.current,
              usageFromLanguageModelStep(usage, resolvedConductorModel.modelId),
            );
            usageEmitRef.emit?.();
          },
          prepareStep: async () => {
            const projection = await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
            const persistedState = projection.state;
            if (!persistedState
              || persistedState.buildPhase !== requestPhaseContract.phase
              || (() => {
                const phaseIndex = BUILD_PHASES.indexOf(requestPhaseContract.phase);
                const parent = phaseIndex > 0 ? persistedState.artifacts[BUILD_PHASES[phaseIndex - 1]] : undefined;
                return (parent?.artifactHash ?? "root") !== requestPhaseContract.parentArtifactHash;
              })()) {
              requestContractSuperseded = true;
            }
            const activeTools = activeToolsForPhase();
            const liveProgress = deriveBuildPhaseProgress(currentBuildState!, buildEvents, {
              effectivePhase: requestPhaseContract.phase,
              connectedToolkits: initialConnectors.map((t) => ({
                slug: t.slug,
                connected: Boolean(t.connected),
              })),
              loopStatus: currentLoopStatus,
            });
            const mandatoryToolInstruction = buildMandatoryNextToolInstruction(liveProgress.nextTool);
            const systemPrompt = mandatoryToolInstruction
              ? `${buildCurrentSystemPrompt()}\n\n${mandatoryToolInstruction}`
              : buildCurrentSystemPrompt();
            return {
              system: systemPrompt,
              activeTools: activeTools as never[],
              toolChoice: modelGateway.resolveToolChoice(activeTools.length),
            };
          },
          messages: prepared.modelMessages,
          tools: {
        analyzeIntent: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent,
          inputSchema: analyzeIntentInputSchema,
          execute: async (analysis) => {
            const execution = beginToolExecution("analyzeIntent", "intent");
            if (execution.duplicate) {
              return duplicateToolExecution("analyzeIntent", analysis, execution, "Intent analysis already exists for the current revision");
            }
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
            return finalizeToolExecution("analyzeIntent", analysis, execution, { ok: true as const, analysis });
          },
        }),
        discoverConnectorsForBlueprint: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.discoverConnectorsForBlueprint,
          inputSchema: discoverConnectorsForBlueprintInputSchema,
          execute: async (input) => {
            const execution = beginToolExecution("discoverConnectorsForBlueprint", "blueprint", { historicalDedup: false });
            if (execution.duplicate) {
              return duplicateToolExecution(
                "discoverConnectorsForBlueprint",
                input,
                execution,
                "Connector discovery already ran for the current revision",
              );
            }
            const discovered = preparedConnectorDiscovery ?? await discoverConnectorsForBlueprint(auth, {
                ...input,
                previousSelections: connectorSelectionEvidence(buildEvents),
                previousConnectors: (currentSpec!.taskBlueprint?.outcomes ?? [])
                  .map((outcome) => outcome.selectedConnector)
                  .filter((connector): connector is string => Boolean(connector)),
              });
            preparedConnectorDiscovery = null;
            await applyAutoResolvedConnectors(discovered);
            return finalizeToolExecution("discoverConnectorsForBlueprint", input, execution, discovered);
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
            const resolved = await resolveToolkitSlug(toolkit);
            const execution = beginToolExecution("listTriggers", `toolkit:${resolved}`, { historicalDedup: false });
            if (execution.duplicate) {
              return duplicateToolExecution("listTriggers", { toolkit: resolved }, execution, `Triggers for ${resolved} were already listed for the current revision`);
            }
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
              })),
            }));
            triggerLists.push({ toolkit: resolved, triggers });
            return finalizeToolExecution("listTriggers", { toolkit: resolved }, execution, {
              toolkit: resolved,
              triggers,
              spec: currentSpec,
            });
          },
        }),
        listActions: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.listActions,
          inputSchema: listActionsInputSchema,
          execute: async ({ toolkit }) => {
            const resolved = await resolveToolkitSlug(toolkit);
            const execution = beginToolExecution("listActions", `toolkit:${resolved}`, { historicalDedup: false });
            if (execution.duplicate) {
              return duplicateToolExecution("listActions", { toolkit: resolved }, execution, `Actions for ${resolved} were already listed for the current revision`);
            }
            const actions = await getAllTools(resolved);
            const triggerSlug = currentSpec?.trigger?.kind === "event"
              ? currentSpec.trigger.composioSlug
              : undefined;
            const triggerFieldNames = triggerSlug
              ? getTriggerFieldNamesForFeasibility(triggerSlug)
              : [];
            return finalizeToolExecution("listActions", { toolkit: resolved }, execution, {
              toolkit: resolved,
              actions: actions.map((action) => {
                const feasibility = enrichBindingActionCandidate({
                  actionSlug: action.actionSlug,
                  name: action.name,
                  description: action.description,
                  inputSchema: action.inputSchema ?? { type: "object", properties: {} },
                  outputSchema: action.outputSchema,
                  context: {
                    triggerSlug,
                    triggerFieldNames,
                  },
                });
                return {
                  slug: action.actionSlug,
                  name: action.name,
                  description: action.description,
                  requiredFields: feasibility.requiredFields,
                  feasible: feasibility.feasible,
                  ...(feasibility.feasibilityReason ? { feasibilityReason: feasibility.feasibilityReason } : {}),
                };
              }),
            });
          },
        }),
        discoverBindings: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.discoverBindings,
          inputSchema: discoverBindingsInputSchema,
          execute: async (input) => {
            const execution = beginToolExecution(
              "discoverBindings",
              `toolkit:${input.toolkit.toLowerCase()}`,
              { historicalDedup: false },
            );
            if (execution.duplicate) {
              return duplicateToolExecution("discoverBindings", input, execution, `Bindings for ${input.toolkit} were already discovered for the current revision`);
            }
            const selected = new Set((currentBuildState!.artifacts.connectors?.artifact as { selections?: Array<{ connector: string }> })
              ?.selections?.map((row) => row.connector.toLowerCase()) ?? []);
            if (!selected.has(input.toolkit.toLowerCase())) {
              return finalizeToolExecution("discoverBindings", input, execution, {
                ok: false as const,
                error: `Cannot discover bindings for unselected connector ${input.toolkit}`,
                retryAllowed: true,
                recoverToPhase: "connectors",
                recoverReason: "connector_not_selected",
              });
            }
            const expectedOutcomes = bindingActionOutcomesForToolkit(currentSpec!, input.toolkit);
            const discovered = await discoverOutcomeBindings(input.toolkit, expectedOutcomes);
            return finalizeToolExecution("discoverBindings", input, execution, {
              ...discovered,
              spec: currentSpec,
            });
          },
        }),
        resolveBindings: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.resolveBindings,
          inputSchema: resolveBindingsInputSchema,
          execute: async () => {
            const blueprintOutcomes = currentSpec!.taskBlueprint?.outcomes ?? [];
            const actionOutcomes = blueprintOutcomes.filter((outcome): outcome is typeof outcome & {
              role: "source" | "destination"; selectedConnector: string;
            } => (outcome.role === "source" || outcome.role === "destination") && Boolean(outcome.selectedConnector));
            const triggerOutcome = blueprintOutcomes.find((outcome) =>
              outcome.role === "trigger" && Boolean(outcome.selectedConnector));

            const latestDiscoveryByToolkit = new Map<string, Record<string, unknown>>();
            for (const event of completedToolEvents(buildEvents, "discoverBindings")) {
              const output = recordValue(event.output);
              const toolkit = String(output?.toolkit ?? "").toLowerCase();
              if (toolkit) latestDiscoveryByToolkit.set(toolkit, output!);
            }
            const catalogues = new Map<string, Awaited<ReturnType<typeof getAllTools>>>();
            await Promise.all([...new Set(actionOutcomes.map((outcome) => outcome.selectedConnector.toLowerCase()))]
              .map(async (toolkit) => catalogues.set(toolkit, await getAllTools(toolkit))));

            let trigger: BindingResolverTrigger | null = null;
            if (triggerOutcome?.selectedConnector) {
              const connector = triggerOutcome.selectedConnector;
              const rows = triggerLists.flatMap((list) => list.toolkit.toLowerCase() === connector.toLowerCase()
                ? list.triggers : []);
              const ranked = rows.map((row) => ({
                row,
                score: scoreTriggerSlugMatch(triggerOutcome.description, String(row.slug ?? ""), String(row.name ?? "")),
              })).filter((candidate) => String(candidate.row.slug ?? ""))
                .sort((left, right) => right.score - left.score);
              const close = ranked[0] ? ranked.filter((candidate) => candidate.score >= ranked[0]!.score - 1) : [];
              trigger = {
                outcomeId: triggerOutcome.id,
                connector,
                description: triggerOutcome.description,
                candidates: close.slice(0, 5).map(({ row }) => {
                  const configSchema = recordValue(row.config) ?? {};
                  return {
                    slug: String(row.slug ?? ""),
                    name: String(row.name ?? row.slug ?? "Trigger"),
                    configSchema,
                    configurableFields: Array.isArray(row.configurableFields)
                      ? row.configurableFields as BindingResolverTrigger["candidates"][number]["configurableFields"]
                      : extractConfigurableFields(configSchema),
                  };
                }),
              };
            }

            const firstBindingEvidenceSequence = buildEvents.find((event) =>
              event.type === "tool_call.completed"
              && ["discoverBindings", "listTriggers"].includes(String(event.payload.toolName ?? "")))?.sequence ?? 0;
            const answers: BindingResolverAnswer[] = filterBindingResolutionAnswers(buildEvents.flatMap((event) => {
              if (event.sequence <= firstBindingEvidenceSequence
                || event.type !== "tool_call.completed"
                || event.payload.toolName !== "askQuestion") return [];
              const input = recordValue(event.payload.input);
              const output = recordValue(event.payload.output);
              if (!input || !output || output.skipped === true) return [];
              return [{
                questionId: String(output.questionId ?? input.questionId ?? ""),
                question: String(input.question ?? ""),
                answerText: String(output.answerText ?? ""),
                selectedOptionIds: Array.isArray(output.selectedOptionIds) ? output.selectedOptionIds.map(String) : [],
                selectedValues: Array.isArray(output.selectedValues) ? output.selectedValues.map(String) : [],
                ...(typeof output.otherText === "string" ? { otherText: output.otherText } : {}),
              }];
            }));
            const pinnedTriggerSlug = pinnedTriggerSlugFromInput({ actions: [], trigger, answers });
            const triggerFieldNames = pinnedTriggerSlug
              ? getTriggerFieldNamesForFeasibility(pinnedTriggerSlug)
              : [];

            const actions: BindingResolverAction[] = actionOutcomes.map((outcome, outcomeIndex) => {
              const connector = outcome.selectedConnector;
              const discovery = latestDiscoveryByToolkit.get(connector.toLowerCase());
              const ambiguities = Array.isArray(discovery?.ambiguities) ? discovery.ambiguities : [];
              const suggestions = Array.isArray(discovery?.suggestedBindings) ? discovery.suggestedBindings : [];
              const ambiguity = ambiguities.map(recordValue).find((row) => String(row?.outcomeId ?? "") === outcome.id);
              const suggestion = suggestions.map(recordValue).find((row) => String(row?.outcomeId ?? "") === outcome.id);
              const candidateRows = ambiguity && Array.isArray(ambiguity.candidates)
                ? ambiguity.candidates.map(recordValue).filter((row): row is Record<string, unknown> => Boolean(row))
                : suggestion ? [{ actionSlug: String(suggestion.actionSlug ?? "") }] : [];
              const catalogue = catalogues.get(connector.toLowerCase()) ?? [];
              const priorActions = actionOutcomes.slice(0, outcomeIndex).flatMap((priorOutcome) => {
                const priorDiscovery = latestDiscoveryByToolkit.get(priorOutcome.selectedConnector.toLowerCase());
                const priorSuggestions = Array.isArray(priorDiscovery?.suggestedBindings)
                  ? priorDiscovery.suggestedBindings
                  : [];
                const priorSuggestion = priorSuggestions.map(recordValue)
                  .find((row) => String(row?.outcomeId ?? "") === priorOutcome.id);
                const priorSlug = String(priorSuggestion?.actionSlug ?? "");
                if (!priorSlug) return [];
                const priorLive = (catalogues.get(priorOutcome.selectedConnector.toLowerCase()) ?? [])
                  .find((candidate) => candidate.actionSlug === priorSlug);
                if (!priorLive) return [];
                return [{
                  actionSlug: priorSlug,
                  outputSchema: priorLive.outputSchema,
                }];
              });
              return {
                outcomeId: outcome.id,
                connector,
                role: outcome.role,
                description: outcome.description,
                candidates: candidateRows.flatMap((row) => {
                  const actionSlug = String(row.actionSlug ?? "");
                  const live = catalogue.find((candidate) => candidate.actionSlug === actionSlug);
                  if (!actionSlug || !live) return [];
                  const enriched = enrichBindingActionCandidate({
                    actionSlug,
                    name: live.name,
                    description: live.description,
                    inputSchema: live.inputSchema ?? { type: "object", properties: {} },
                    outputSchema: live.outputSchema,
                    context: {
                      triggerSlug: pinnedTriggerSlug,
                      triggerFieldNames,
                      priorActions,
                    },
                  });
                  return [enriched];
                }),
              };
            });
            const resolutionInput = { actions, trigger, answers, userId: auth.userId };
            const evidenceHash = eventPayloadHash({
              blueprintHash: currentBuildState!.artifacts.blueprint!.artifactHash,
              connectorHash: currentBuildState!.artifacts.connectors!.artifactHash,
              actions,
              trigger,
              answers,
            });
            const execution = beginToolExecution("resolveBindings", `evidence:${evidenceHash}`, { historicalDedup: false });
            if (execution.duplicate) {
              return duplicateToolExecution("resolveBindings", {}, execution, "These binding choices were already resolved for the current revision");
            }
            if (actions.some((action) => action.candidates.length === 0) || (triggerOutcome && (!trigger || trigger.candidates.length === 0))) {
              return finalizeToolExecution("resolveBindings", {}, execution, {
                ok: false as const,
                missingDiscovery: true,
                requiredToolkits: [...new Set([
                  ...actions.filter((action) => action.candidates.length === 0).map((action) => action.connector),
                  ...(triggerOutcome && (!trigger || trigger.candidates.length === 0) ? [triggerOutcome.selectedConnector!] : []),
                ])],
                retryAllowed: true,
              });
            }
            const connectionStatuses = await Promise.all([...new Set([
              ...actions.map((action) => action.connector),
              ...(trigger ? [trigger.connector] : []),
            ])].map((connector) => getToolkitConnectionStatus(auth, connector)));
            const disconnected = connectionStatuses.filter((status) => !status.connected);
            if (disconnected.length > 0) {
              const diagnostics: BindingDiagnostic[] = disconnected.map((status) => ({
                code: "CONNECTOR_NOT_CONNECTED",
                message: `${status.toolkit} is not connected in this workspace.`,
                connector: status.toolkit,
                expected: "An active workspace connection",
                action: `Connect ${status.toolkit} before resolving bindings.`,
                technical: { connector: status.toolkit, connectionStatus: status.status },
              }));
              await persistBindingDiagnostics(diagnostics);
              return finalizeToolExecution("resolveBindings", {}, execution, {
                ok: false as const,
                diagnostics,
                retryAllowed: true,
                recoverToPhase: "connectors",
                recoverReason: "connector_not_connected",
                resumeTool: "connectToolkit",
              });
            }
            if (pinnedTriggerSlug) {
              const infeasibleDiagnostics = findNoFeasibleActionDiagnostics(resolutionInput);
              if (infeasibleDiagnostics.length > 0) {
                const diagnostics: BindingDiagnostic[] = infeasibleDiagnostics.map((row) => ({
                  code: row.code,
                  message: row.message,
                  connector: row.connector,
                  expected: "At least one action whose required fields can be sourced from the selected trigger",
                  action: row.reason,
                  technical: {
                    outcomeId: row.outcomeId,
                    reason: row.reason,
                    feasibleAlternatives: row.feasibleAlternatives,
                  },
                }));
                await persistBindingDiagnostics(diagnostics);
                return finalizeToolExecution("resolveBindings", {}, execution, {
                  ok: false as const,
                  diagnostics,
                  retryAllowed: true,
                });
              }
            }
            const prepared = prepareBindingResolution(resolutionInput);
            if (!prepared.ready) {
              return finalizeToolExecution("resolveBindings", {}, execution, {
                ok: true as const,
                pendingQuestions: prepared.pendingQuestions,
                retryAllowed: true,
              });
            }
            try {
              const resolved = await resolvePreparedBindings(prepared, { userId: auth.userId });
              await appendBuildEvents(auth, loopId, [{
                eventKey: `binding-resolved:${evidenceHash}`,
                type: "binding.resolved",
                payload: {
                  artifact: resolved.artifact,
                  evidenceHash,
                  blueprintHash: currentBuildState!.artifacts.blueprint!.artifactHash,
                  connectorHash: currentBuildState!.artifacts.connectors!.artifactHash,
                },
              }]);
              await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
              const artifact = interpretBindingDiscovery(currentBuildState!, buildEvents);
              if (!artifact) throw new Error("Resolved binding event could not be interpreted");
              const committed = await recordArtifact("bindings", artifact, currentBuildState!.artifacts.connectors!.artifactHash);
              return finalizeToolExecution("resolveBindings", {}, execution, {
                ok: true as const,
                artifactHash: committed.envelope.artifactHash,
                spec: currentSpec,
              });
            } catch (error) {
              const failure = describeBindingResolutionError(error);
              const diagnostics: BindingDiagnostic[] = [{
                code: failure.code,
                message: failure.message,
                expected: "One schema-valid binding artifact using the current provider catalogue",
                action: failure.code === "BINDING_RESOLVER_PROVIDER_ERROR"
                  ? "Retry binding resolution or configure TALLEI_CONDUCTOR__MODEL to a model that supports structured JSON output."
                  : failure.code === "INVALID_BINDING_SCOPE_ANSWER"
                    ? "Call resolveBindings again and answer the returned pendingQuestions exactly."
                    : failure.code === "INVALID_BINDING_SELECTION"
                      ? "Call resolveBindings again and choose one of the server-offered feasible actions."
                      : "Retry binding resolution with the same confirmed choices.",
                technical: {
                  evidenceHash,
                  error: error instanceof Error ? error.message.slice(0, 500) : "Unknown binding resolution error",
                },
              }];
              await persistBindingDiagnostics(diagnostics);
              return finalizeToolExecution("resolveBindings", {}, execution, {
                ok: false as const,
                diagnostics,
                retryAllowed: true,
              });
            }
          },
        }),
        connectToolkit: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.connectToolkit,
          inputSchema: connectToolkitInputSchema,
          execute: async ({ toolkit, callbackUrl }) => {
            const execution = beginToolExecution("connectToolkit", `toolkit:${toolkit.toLowerCase()}`, { historicalDedup: false });
            if (execution.duplicate) {
              return duplicateToolExecution("connectToolkit", { toolkit, callbackUrl }, execution, `${toolkit} connection is already in progress`);
            }
            const authorization = await startToolkitAuthorization(auth, toolkit, { callbackUrl });
            return finalizeToolExecution("connectToolkit", { toolkit, callbackUrl }, execution, {
              ok: true,
              toolkit: authorization.toolkit,
              redirectUrl: authorization.redirectUrl,
              connectionRequestId: authorization.connectionRequestId,
            });
          },
        }),
        listWorkspaceConnectors: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.listWorkspaceConnectors,
          inputSchema: listWorkspaceConnectorsInputSchema,
          execute: async () => {
            const execution = beginToolExecution("listWorkspaceConnectors", "workspace", { historicalDedup: false });
            if (execution.duplicate) {
              return duplicateToolExecution("listWorkspaceConnectors", {}, execution, "Workspace connectors were already listed in this turn");
            }
            const connectors = await listWorkspaceConnectors(auth);
            return finalizeToolExecution("listWorkspaceConnectors", {}, execution, {
              connectors: connectors.map((connector) => ({
                slug: connector.slug,
                name: connector.name,
                connected: Boolean(connector.connected),
              })),
            });
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
            const execution = beginToolExecution(
              "presentAgentTeam",
              `review:${currentBuildState!.artifacts.bindings?.artifactHash ?? computeOutcomeBriefHash(currentSpec!)}`,
              { historicalDedup: false },
            );
            if (execution.duplicate) {
              const progress = deriveBuildPhaseProgress(currentBuildState!, buildEvents, {
                effectivePhase: "review",
                loopStatus: currentLoopStatus,
              });
              if (progress.nextTool === "confirmOutcomeBrief") {
                return finalizeToolExecution("presentAgentTeam", input, execution, {
                  ok: false as const,
                  error: "The review roster is already prepared. Call confirmOutcomeBrief now.",
                  retryAllowed: true,
                  requiresUserInput: false,
                  recoverToPhase: "review",
                  recoverReason: "confirm_outcome_brief_pending",
                  resumeTool: "compileLoop",
                });
              }
              return duplicateToolExecution("presentAgentTeam", input, execution, "The review roster is already prepared for the current revision");
            }
            return finalizeToolExecution("presentAgentTeam", input, execution, {
              ...normalizeAgentTeam(input, currentSpec!),
              reviewHandoffNext: "confirmOutcomeBrief" as const,
            });
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
            const execution = beginToolExecution(
              "compileLoop",
              `compile:${currentBuildState!.artifacts.review?.artifactHash ?? currentBuildState!.artifacts.bindings?.artifactHash ?? "missing"}`,
            );
            if (execution.duplicate) {
              return duplicateToolExecution("compileLoop", {}, execution, "This revision has already been compiled");
            }
            if (currentBuildState!.buildPhase !== "compile") {
              const reviewPending = currentBuildState!.buildPhase === "review";
              if (reviewPending) {
                return finalizeToolExecution("compileLoop", {}, execution, {
                  ok: false as const,
                  error: "Review isn't complete yet. Confirm the specialist team summary before compiling.",
                  retryAllowed: true,
                  requiresUserInput: false,
                  recoverToPhase: "review",
                  recoverReason: "confirm_outcome_brief_pending",
                  resumeTool: "compileLoop",
                });
              }
              return finalizeToolExecution("compileLoop", {}, execution, {
                ok: false as const,
                error: `Cannot compile during the ${currentBuildState!.buildPhase} step.`,
                retryAllowed: false,
                requiresUserInput: false,
              });
            }
            let compiled: Awaited<ReturnType<typeof compileLoop>>;
            try {
              compiled = await compileLoop(auth, loopId);
            } catch (error) {
              if (error instanceof BuildStateError) {
                const reviewPending = error.code === BUILD_ERROR_CODES.INVALID_TRANSITION;
                if (reviewPending) {
                  return finalizeToolExecution("compileLoop", {}, execution, {
                    ok: false as const,
                    error: "Review isn't complete yet. Confirm the specialist team summary before compiling.",
                    retryAllowed: true,
                    requiresUserInput: false,
                    recoverToPhase: "review",
                    recoverReason: "confirm_outcome_brief_pending",
                    resumeTool: "compileLoop",
                  });
                }
                return finalizeToolExecution("compileLoop", {}, execution, {
                  ok: false as const,
                  error: error.message,
                  retryAllowed: false,
                  requiresUserInput: false,
                });
              }
              throw error;
            }
            if (compiled.errors.length > 0) {
              const diagnostics = compiled.errors.map((error) => ({
                code: String(error.code),
                message: error.message,
                connector: error.toolkit,
                rejectedValue: error.binding,
                expected: "A binding that matches the current provider catalogue and workspace connection",
                action: error.code === "CONNECTOR_NOT_CONNECTED"
                  ? `Reconnect ${error.toolkit ?? "the connector"}, then compile again.`
                  : "Run binding discovery again for this workflow step, then compile again.",
                technical: {
                  compilerCode: String(error.code),
                  ...(error.toolkit ? { toolkit: error.toolkit } : {}),
                  ...(error.binding ? { binding: error.binding } : {}),
                },
              }));
              await appendBuildEvents(auth, loopId, [{
                eventKey: `binding-diagnostic:compile:${eventPayloadHash(diagnostics)}`,
                type: "binding.diagnostic",
                payload: { diagnostics },
              }]);
              return finalizeToolExecution("compileLoop", {}, execution, {
                ok: false as const,
                errors: compiled.errors,
                diagnostics,
                retryAllowed: false,
              });
            }
            latestCompiledPlanId = compiled.plan!.id;
            latestTestRunPass = null;
            await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
            return finalizeToolExecution("compileLoop", {}, execution, {
              ok: true as const,
              plan: {
                id: compiled.plan!.id,
                revision: compiled.plan!.revision,
                toolCount: compiled.plan!.toolCatalog.length,
                profile: compiled.plan!.profile,
              },
              spec: currentSpec,
            });
          },
        }),
        testRunLoop: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.testRunLoop,
          inputSchema: testRunLoopInputSchema,
          execute: async ({ compiledPlanId, scenario }) => {
            const planId = requestPhaseContract.compiledPlanId;
            const scenarioHash = eventPayloadHash(scenario);
            const beginTestExecution = (target: string) => beginToolExecution(
              "testRunLoop",
              target,
              { historicalDedup: false },
            );
            const completeTestPhase = (
              execution: { operationKey: string; phaseBefore: BuildPhase; parentArtifactHash: string },
              runId: string,
              extra?: Record<string, unknown>,
            ) => finalizeToolExecution("testRunLoop", { compiledPlanId: planId, scenario }, execution, {
              ok: true as const,
              runId,
              phaseCompleted: true,
              turnOutcome: "phase_complete" as const,
              continuation: "next_phase" as const,
              nextPhase: "activation" as const,
              ...extra,
            });

            if (compiledPlanId && compiledPlanId !== planId) {
              const execution = beginTestExecution(`test:${planId ?? "missing"}:${scenarioHash}:mismatch`);
              return finalizeToolExecution("testRunLoop", { compiledPlanId, scenario }, execution, {
                ok: false as const,
                error: "The requested compiled plan does not match the current test phase.",
                retryAllowed: false,
              });
            }
            if (!planId) {
              const execution = beginTestExecution(`test:missing:${scenarioHash}`);
              const recovered = await recoverLoopBuildToCompile(auth, loopId, "compiled_artifact_missing");
              await refreshBuildProjection({ effectivePhase: "compile" });
              return finalizeToolExecution("testRunLoop", { compiledPlanId, scenario }, execution, {
                ok: false as const,
                error: "The compiled plan is missing. Returning to compilation automatically.",
                retryAllowed: false,
                recoveryPhase: "compile" as const,
                recoveryReason: "compiled_artifact_missing",
                invalidatedPhases: recovered.invalidatedPhases,
                turnOutcome: "phase_complete" as const,
                continuation: "next_phase" as const,
                nextPhase: "compile" as const,
              });
            }

            const compileEnvelope = currentBuildState!.artifacts.compile;
            const testEnvelope = currentBuildState!.artifacts.test;
            if (compileEnvelope && testEnvelope) {
              const parsed = testArtifactSchema.safeParse(testEnvelope.artifact);
              if (parsed.success && parsed.data.compileHash === compileEnvelope.artifactHash) {
                const execution = beginTestExecution(`test:${planId}:${scenarioHash}:satisfied`);
                if (execution.duplicate) {
                  return duplicateToolExecution(
                    "testRunLoop",
                    { compiledPlanId, scenario },
                    execution,
                    "This test scenario is already running in the current turn.",
                  );
                }
                return completeTestPhase(execution, parsed.data.runId, { alreadySatisfied: true });
              }
            }

            const inMemoryPass = latestTestRunPass?.planId === planId ? latestTestRunPass : null;
            const storedPass = inMemoryPass
              ?? await getLatestPassingTestRunForPlan(auth, loopId, planId);
            if (storedPass && compileEnvelope && currentBuildState!.buildPhase === "test") {
              const execution = beginTestExecution(`test:${planId}:${scenarioHash}:heal:${storedPass.runId}`);
              if (execution.duplicate) {
                return duplicateToolExecution(
                  "testRunLoop",
                  { compiledPlanId, scenario },
                  execution,
                  "This test scenario is already running in the current turn.",
                );
              }
              latestTestRunPass = { planId, runId: storedPass.runId };
              await recordLoopTestResult(auth, loopId, {
                compiledPlanId: planId,
                runId: storedPass.runId,
                passed: true,
              });
              await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
              return completeTestPhase(execution, storedPass.runId, { recoveredFromStoredPass: true });
            }

            const execution = beginTestExecution(`test:${planId}:${scenarioHash}:${randomUUID()}`);
            if (execution.duplicate) {
              return duplicateToolExecution(
                "testRunLoop",
                { compiledPlanId, scenario },
                execution,
                "This test scenario is already running in the current turn.",
              );
            }
            const result = await executeLoopTestRun(auth, {
              loopId,
              compiledPlanId: planId,
              scenario,
            });
            const recoveryCode = result.steps.find((step) => step.kind === "error"
              && (step.code === "PLAN_NOT_FOUND" || step.code === "STALE_PLAN"));
            if (recoveryCode?.kind === "error") {
              const recoveryReason = recoveryCode.code === "PLAN_NOT_FOUND"
                ? "compiled_plan_missing"
                : "compiled_artifact_stale";
              const recovered = await recoverLoopBuildToCompile(auth, loopId, recoveryReason);
              await refreshBuildProjection({ effectivePhase: "compile" });
              return finalizeToolExecution("testRunLoop", { compiledPlanId: planId, scenario }, execution, {
                ...result,
                error: "The compiled plan is no longer current. Returning to compilation automatically.",
                retryAllowed: false,
                recoveryPhase: "compile" as const,
                recoveryReason,
                invalidatedPhases: recovered.invalidatedPhases,
                turnOutcome: "phase_complete" as const,
                continuation: "next_phase" as const,
                nextPhase: "compile" as const,
              });
            }
            if (result.ok) {
              latestTestRunPass = { planId, runId: result.runId };
              await recordLoopTestResult(auth, loopId, {
                compiledPlanId: planId, runId: result.runId, passed: true,
              });
              await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
              return completeTestPhase(execution, result.runId, result);
            }
            return finalizeToolExecution("testRunLoop", { compiledPlanId: planId, scenario }, execution, {
              ...result,
              retryAllowed: true,
            });
          },
        }),
        activateLoop: tool({
          description: CONDUCTOR_TOOL_DESCRIPTIONS.activateLoop,
          inputSchema: activateLoopInputSchema,
          execute: async ({ compiledPlanId, confirmedByUser }) => {
            const planId = requestPhaseContract.compiledPlanId;
            const execution = beginToolExecution("activateLoop", `activate:${planId ?? "missing"}`);
            if (execution.duplicate) {
              if (execution.contractError) {
                await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
                const activeLoop = await getLoop(auth, loopId);
                const resolvedPlanId = planId ?? activeLoop?.activePlanId ?? compiledPlanId;
                if (activeLoop?.status === "active" && resolvedPlanId) {
                  return finalizeToolExecution("activateLoop", { compiledPlanId: resolvedPlanId, confirmedByUser }, execution, {
                    ok: true as const,
                    loopId,
                    activePlanId: resolvedPlanId,
                    status: "active" as const,
                    alreadyActive: true,
                    phaseCompleted: true,
                    turnOutcome: "build_complete" as const,
                    continuation: "stop" as const,
                  });
                }
                return duplicateToolExecution(
                  "activateLoop",
                  { compiledPlanId, confirmedByUser },
                  execution,
                  "This compiled plan is already active for the current revision",
                );
              }
              await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
              const activeLoop = await getLoop(auth, loopId);
              const resolvedPlanId = planId ?? activeLoop?.activePlanId ?? compiledPlanId;
              return finalizeToolExecution("activateLoop", { compiledPlanId: planId, confirmedByUser }, execution, {
                ok: true as const,
                loopId,
                activePlanId: resolvedPlanId,
                status: "active" as const,
                alreadyActive: true,
                phaseCompleted: true,
                turnOutcome: "build_complete" as const,
                continuation: "stop" as const,
              });
            }
            if (compiledPlanId && compiledPlanId !== planId) {
              return finalizeToolExecution("activateLoop", { compiledPlanId, confirmedByUser }, execution, {
                ok: false as const,
                error: "The requested compiled plan does not match the current activation phase.",
                retryAllowed: false,
              });
            }
            if (!planId) {
              return finalizeToolExecution("activateLoop", { compiledPlanId, confirmedByUser }, execution, {
                ok: false as const,
                error: "No compiled plan — call compileLoop first",
                retryAllowed: false,
              });
            }
            const inMemoryPass = latestTestRunPass?.planId === planId ? latestTestRunPass : null;
            const storedPass = inMemoryPass
              ? inMemoryPass
              : await getLatestPassingTestRunForPlan(auth, loopId, planId);
            if (!storedPass) {
              return finalizeToolExecution("activateLoop", { compiledPlanId: planId, confirmedByUser }, execution, {
                ok: false as const,
                error: "Run testRunLoop on this plan before activating",
                retryAllowed: false,
              });
            }
            const activationApproved = completedToolEvents(buildEvents, "presentReplyOptions").some((event) =>
              isActivationConfirmationReply(event.output, event.input));
            if (!activationApproved) {
              return finalizeToolExecution("activateLoop", { compiledPlanId: planId, confirmedByUser }, execution, {
                ok: false as const,
                error: "Call presentReplyOptions and wait for explicit activation approval first.",
                retryAllowed: true,
              });
            }
            const activated = await activateLoop(auth, loopId, planId, confirmedByUser);
            await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
            latestCompiledPlanId = activated.activePlanId;
            return finalizeToolExecution("activateLoop", { compiledPlanId: planId, confirmedByUser }, execution, {
              ok: true as const,
              ...activated,
              phaseCompleted: true,
              turnOutcome: "build_complete",
              continuation: "stop",
            });
          },
        }),
      },
    }),
      };
    };

    const consumePendingHandoffIfNeeded = async (): Promise<boolean> => {
      const projection = await refreshBuildProjection();
      const intent = projection.continuationIntent;
      if (!intent || intent.trigger !== "phase_handoff") return false;
      if (!shouldAutoContinueConductorSession(intent)) return false;
      const payload = phaseHandoffConsumePayloadFromTurn(intent, projection.latestPhaseTurn);
      if (!payload) {
        // handoffPending without a full phase-turn payload: rebuild contract and continue.
        rebuildPhaseContract();
        return true;
      }
      const alreadyConsumed = buildEvents.some((event) =>
        event.type === "phase_handoff.consumed" && event.payload.handoffId === payload.handoffId);
      if (!alreadyConsumed) {
        await appendBuildEvents(auth, loopId, [makePhaseHandoffConsumedEvent(payload)]);
        await refreshBuildProjection();
      }
      rebuildPhaseContract();
      return true;
    };

    const writeServerOwnedPickConnectorApp = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      writer: { write: (chunk: any) => void },
      originalMessages: UIMessage[],
    ): Promise<UIMessage[] | null> => {
      const ensured = ensurePendingPickConnectorApp({
        messages: originalMessages,
        state: currentBuildState!,
        pendingUiTool: derivePendingUiToolFromEvents(buildEvents),
        nextTool: requestPhaseContract.nextTool,
        phase: requestStartPhase,
      });
      if (!ensured.injected || !ensured.toolCallId || !ensured.outcomeId) return null;

      const role = (() => {
        const last = ensured.messages.at(-1);
        for (const part of [...(last?.parts ?? [])].reverse()) {
          if (part.type !== "tool-pickConnectorApp") continue;
          const input = (part as { input?: { role?: string } }).input;
          if (input?.role === "trigger" || input?.role === "source" || input?.role === "destination") {
            return input.role;
          }
        }
        return "destination" as const;
      })();

      await saveBuildChatMessages(auth, loopId, ensured.messages);
      await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
      console.info(`[loops/chat:${loopId}] presenting server-owned pickConnectorApp`, {
        loopId,
        toolCallId: ensured.toolCallId,
        outcomeId: ensured.outcomeId,
        role,
      });

      writer.write({
        type: "tool-input-available",
        toolCallId: ensured.toolCallId,
        toolName: "pickConnectorApp",
        input: {
          outcomeId: ensured.outcomeId,
          role,
        },
      });
      return ensured.messages;
    };

    const mergeConductorTurn = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      writer: { write: (chunk: any) => void; merge: (stream: ReadableStream<any>) => void },
      prepared: Awaited<ReturnType<typeof startConductorStream>>,
      originalMessages: UIMessage[],
    ): Promise<{ messages: UIMessage[]; isAborted: boolean }> => {
      const currentSessionUsage = () => buildConductorSessionUsage(
        prepared.sessionUsageBase,
        prepared.turnUsageState.current,
      );
      const emitLiveUsage = () => {
        writer.write({
          type: "data-usage",
          data: currentSessionUsage(),
          transient: true,
        });
      };
      usageEmitRef.emit = emitLiveUsage;
      streamErrorEmitRef.emit = (message) => {
        writer.write({
          type: "data-conductor-error",
          data: { message },
          transient: true,
        });
      };
      emitLiveUsage();

      return await new Promise<{ messages: UIMessage[]; isAborted: boolean }>((resolve, reject) => {
        writer.merge(prepared.result.toUIMessageStream({
          originalMessages,
          generateMessageId: () => randomUUID(),
          sendReasoning: modelGateway.shouldSendReasoning(prepared.surface),
          messageMetadata: () => {
            const turnUsage = finalizeConductorChatUsage(prepared.turnUsageState.current);
            return {
              usage: turnUsage,
              sessionUsage: currentSessionUsage(),
            };
          },
          onFinish: async ({ messages, isAborted }) => {
            const streamElapsedMs = turnStreamStartedAt > 0
              ? Math.round(performance.now() - turnStreamStartedAt)
              : 0;
            usageEmitRef.emit?.();
            try {
              if (isAborted) {
                await appendBuildEvents(auth, loopId, interruptionEventsFromUiMessages(messages));
              }
              const saveStarted = performance.now();
              await saveBuildChatMessages(auth, loopId, messages);
              const saveMs = Math.round(performance.now() - saveStarted);
              const bookkeepingTimings = await finalizeConductorTurnBookkeeping({
                auth,
                loopId,
                messages,
                isAborted,
                streamElapsedMs,
                stepTimingsMs: [...turnStepTimingsMs],
                requestPhaseContract,
                requestStartPhase,
                requestStartParentArtifactHash,
                requestStepLimit,
                turnStepCount,
                turnStreamError,
                lastToolExecution,
                modelId: prepared.modelId,
                currentBuildState: currentBuildState!,
                currentLoopStatus,
                refreshBuildProjection,
                appendBuildEvents,
                saveBuildChatMessages,
              });
              if (process.env.NODE_ENV !== "production") {
                console.debug(`[loops/chat:${loopId}] onFinish timings`, {
                  saveMs,
                  streamElapsedMs,
                  stepTimingsMs: [...turnStepTimingsMs],
                  bookkeepingTimings,
                });
              }
              // Re-read messages after bookkeeping (may inject pickConnectorApp).
              await refreshBuildProjection({ effectivePhase: requestPhaseContract.phase });
              resolve({ messages: chatMessages, isAborted });
            } catch (error) {
              console.error(`[loops/chat] failed to persist conductor transcript${isAborted ? " after abort" : ""}:`, error);
              reject(error);
            }
          },
        }));
      });
    };

    const pipeConductorSession = (initialMessages: UIMessage[]) => {
      const stream = createUIMessageStream({
        originalMessages: initialMessages,
        execute: async ({ writer }) => {
          let messages = initialMessages;
          let turnsRun = 0;

          while (turnsRun < CONDUCTOR_SESSION_MAX_AUTO_CONTINUATIONS) {
            if (requestPhaseContract.nextTool === "pickConnectorApp") {
              const picked = await writeServerOwnedPickConnectorApp(writer, messages);
              if (picked) {
                console.info(`[loops/chat:${loopId}] session stopped for pickConnectorApp`, {
                  turnsRun,
                  stopReason: "wait_for_user",
                });
                return;
              }
            }

            const prepared = await startConductorStream(messages);
            const finished = await mergeConductorTurn(writer, prepared, messages);
            turnsRun += 1;
            messages = finished.messages;

            if (finished.isAborted) {
              console.info(`[loops/chat:${loopId}] session aborted`, { turnsRun });
              return;
            }

            // Prefer the just-finished transcript for human gates — projection can lag when
            // message ids were missing historically, which left pendingUiTool null.
            const openUiToolInMessages = (() => {
              for (const message of [...messages].reverse()) {
                if (message.role !== "assistant") continue;
                for (const part of [...(message.parts ?? [])].reverse()) {
                  const toolPart = part as {
                    type?: string;
                    toolCallId?: string;
                    toolName?: string;
                    state?: string;
                    output?: unknown;
                  };
                  if (!toolPart.toolCallId) continue;
                  if (toolPart.state !== "input-available" && toolPart.state !== "input-streaming") continue;
                  if (toolPart.output != null) continue;
                  const name = toolPart.toolName
                    ?? (typeof toolPart.type === "string" ? toolPart.type.replace(/^tool-/, "") : "");
                  if (UI_TOOL_ANSWER_TOOLS.includes(name as typeof UI_TOOL_ANSWER_TOOLS[number])) {
                    return { toolCallId: toolPart.toolCallId, toolName: name };
                  }
                }
              }
              return null;
            })();
            if (openUiToolInMessages) {
              console.info(`[loops/chat:${loopId}] session stopped`, {
                turnsRun,
                stopReason: "wait_for_user",
                reason: "pending_user_input",
                trigger: null,
                pendingToolCallId: openUiToolInMessages.toolCallId,
              });
              return;
            }

            const projection = await refreshBuildProjection();
            const intent = projection.continuationIntent;
            if (!shouldAutoContinueConductorSession(intent)) {
              console.info(`[loops/chat:${loopId}] session stopped`, {
                turnsRun,
                stopReason: mapContinuationIntentToStopReason(intent),
                reason: intent?.reason ?? null,
                trigger: intent?.trigger ?? null,
              });
              return;
            }

            if (intent?.trigger === "phase_handoff") {
              await consumePendingHandoffIfNeeded();
            } else {
              rebuildPhaseContract();
            }
            messages = chatMessages;
          }

          console.warn(`[loops/chat:${loopId}] session hit max auto-continuations`, {
            turnsRun,
            max: CONDUCTOR_SESSION_MAX_AUTO_CONTINUATIONS,
          });
        },
      });
      pipeUIMessageStreamToResponse({ response: res, stream });
    };

    const pipeConductorRecoveryMessage = async (originalMessages: UIMessage[]) => {
      const recoveryText = "The previous response was interrupted before it finished. Your message was saved — send again to continue.";
      const recoveryMessage: UIMessage = {
        id: randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: recoveryText }],
      };
      const recoveredMessages = [...originalMessages, recoveryMessage];
      await saveBuildChatMessages(auth, loopId, recoveredMessages);
      const stream = createUIMessageStream({
        originalMessages: originalMessages,
        execute: ({ writer }) => {
          writer.write({ type: "text-start", id: recoveryMessage.id });
          writer.write({ type: "text-delta", id: recoveryMessage.id, delta: recoveryText });
          writer.write({ type: "text-end", id: recoveryMessage.id });
        },
      });
      pipeUIMessageStreamToResponse({
        response: res,
        stream,
      });
    };

    const shouldBreakConfirmLoop = (): boolean => {
      const pending = derivePendingUiToolFromEvents(buildEvents);
      if (pending?.toolName !== "confirmOutcomeBrief") return false;
      const input = pending.input;
      const briefHash = input && typeof input === "object" && "briefHash" in input
        ? String((input as { briefHash?: string }).briefHash ?? "")
        : "";
      return countUncompletedUiToolRequests(buildEvents, "confirmOutcomeBrief", briefHash || undefined) >= 3;
    };

    const pipeConfirmLoopRecovery = async (originalMessages: UIMessage[]) => {
      const recoveryText = "The confirmation prompt is still waiting for your answer above. Use the Confirm or Change buttons instead of sending another message.";
      const recoveryMessage: UIMessage = {
        id: randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: recoveryText }],
      };
      const recoveredMessages = [...originalMessages, recoveryMessage];
      await saveBuildChatMessages(auth, loopId, recoveredMessages);
      const stream = createUIMessageStream({
        originalMessages,
        execute: ({ writer }) => {
          writer.write({ type: "text-start", id: recoveryMessage.id });
          writer.write({ type: "text-delta", id: recoveryMessage.id, delta: recoveryText });
          writer.write({ type: "text-end", id: recoveryMessage.id });
        },
      });
      pipeUIMessageStreamToResponse({
        response: res,
        stream,
      });
    };

    try {
      if (shouldBreakConfirmLoop()) {
        await pipeConfirmLoopRecovery(chatMessages);
        return;
      }
      pipeConductorSession(chatMessages);
    } catch (error) {
      if (!isMissingToolResultsError(error) && !(error instanceof MissingToolResultsError)) {
        throw error;
      }
      const toolCallIds = "toolCallIds" in error && Array.isArray(error.toolCallIds)
        ? error.toolCallIds.map(String)
        : [];
      console.warn(`[loops/chat:${loopId}] missing tool results during replay; attempting recovery`, { toolCallIds });
      await appendBuildEvents(auth, loopId, interruptionEventsForToolCallIds(chatMessages, toolCallIds));
      await refreshBuildProjection();
      chatMessages = buildProjection.chatMessages;
      try {
        pipeConductorSession(chatMessages);
      } catch (retryError) {
        if (!isMissingToolResultsError(retryError) && !(retryError instanceof MissingToolResultsError)) {
          throw retryError;
        }
        console.error(`[loops/chat:${loopId}] conductor replay recovery failed`, {
          toolCallIds: "toolCallIds" in retryError && Array.isArray(retryError.toolCallIds)
            ? retryError.toolCallIds
            : [],
        });
        await pipeConductorRecoveryMessage(chatMessages);
      }
    }
  } catch (error) {
    sendError(res, error, "Failed to stream Conductor chat");
  }
});

/**
 * Accept a human answer for a pending UI-only tool, persist it to the event log,
 * then resume the Conductor session stream (same path as POST /:loopId/chat).
 */
router.post("/:loopId/chat/tool-answer", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const { loopId } = loopIdSchema.parse(req.params);
    const body = z.object({
      toolCallId: z.string().min(1),
      tool: z.enum(UI_TOOL_ANSWER_TOOLS),
      output: z.unknown(),
    }).parse(req.body ?? {});

    const auth = await resolveLoopAuthWorkspace(req.authContext!);
    const loop = await getLoop(auth, loopId);
    if (!loop) {
      res.status(404).json({ error: "Loop not found" });
      return;
    }

    const connectors = await listWorkspaceConnectors(auth);
    const connectedToolkits = connectors.map((toolkit) => ({
      slug: toolkit.slug,
      connected: Boolean(toolkit.connected),
    }));

    const buildEvents = await getBuildEvents(auth, loopId);
    const buildProjection = projectLoopBuildFromEvents(buildEvents, {
      connectedToolkits,
      loopStatus: loop.status,
    });
    if (!buildProjection.state) {
      res.status(400).json({ error: "Loop build state not found" });
      return;
    }

    const openUiToolFromMessages = (messages: UIMessage[], toolCallId: string) => {
      for (const message of [...messages].reverse()) {
        if (message.role !== "assistant") continue;
        for (const part of [...(message.parts ?? [])].reverse()) {
          const toolPart = part as {
            type?: string;
            toolCallId?: string;
            toolName?: string;
            state?: string;
            input?: unknown;
            output?: unknown;
          };
          if (toolPart.toolCallId !== toolCallId) continue;
          if (toolPart.state === "output-available" && toolPart.output != null) {
            return { status: "already_answered" as const };
          }
          const name = toolPart.toolName
            ?? (typeof toolPart.type === "string" ? toolPart.type.replace(/^tool-/, "") : "");
          if (!UI_TOOL_ANSWER_TOOLS.includes(name as typeof UI_TOOL_ANSWER_TOOLS[number])) {
            return { status: "wrong_tool" as const, toolName: name };
          }
          return {
            status: "open" as const,
            toolCallId,
            toolName: name,
            input: toolPart.input,
            messages,
          };
        }
      }
      return { status: "missing" as const };
    };

    const fromProjection = buildProjection.pendingUiTool?.toolCallId === body.toolCallId
      ? {
        status: "open" as const,
        toolCallId: body.toolCallId,
        toolName: buildProjection.pendingUiTool.toolName,
        input: buildProjection.pendingUiTool.input,
        messages: buildProjection.chatMessages,
      }
      : openUiToolFromMessages(buildProjection.chatMessages, body.toolCallId);

    const nextTool = buildProjection.phaseProgress?.nextTool ?? null;
    const canSynthesizeMissingTurn = fromProjection.status === "missing"
      && (nextTool === body.tool || nextTool == null);

    const pending = fromProjection.status === "open" || fromProjection.status === "already_answered"
      ? fromProjection
      : canSynthesizeMissingTurn
        ? {
          status: "open" as const,
          toolCallId: body.toolCallId,
          toolName: body.tool,
          input: {},
          messages: [
            ...buildProjection.chatMessages,
            {
              id: randomUUID(),
              role: "assistant" as const,
              parts: [{
                type: `tool-${body.tool}` as `tool-${string}`,
                toolCallId: body.toolCallId,
                state: "input-available" as const,
                input: {},
              }],
            } as UIMessage,
          ],
        }
        : { status: "missing" as const };

    if (pending.status === "missing") {
      res.status(409).json({
        error: "No matching pending UI tool for this answer",
        pendingToolCallId: buildProjection.pendingUiTool?.toolCallId ?? null,
        nextTool,
      });
      return;
    }
    if (pending.status === "already_answered") {
      res.status(409).json({ error: "This UI tool was already answered" });
      return;
    }
    if (pending.toolName !== body.tool) {
      res.status(409).json({
        error: "Tool name does not match pending UI tool",
        pendingToolName: pending.toolName,
      });
      return;
    }

    const patchedMessages = applyUiToolAnswerToMessages(
      pending.messages,
      body.toolCallId,
      body.output,
    );
    await saveBuildChatMessages(auth, loopId, patchedMessages);

    // Resume via the same chat stream handler (saves again idempotently, then sessions).
    const syntheticReq = Object.create(req) as AuthRequest & {
      method: string;
      url: string;
      body: { messages: UIMessage[] };
      params: { loopId: string };
    };
    syntheticReq.method = "POST";
    syntheticReq.url = `/${loopId}/chat`;
    syntheticReq.body = { messages: patchedMessages };
    syntheticReq.params = { loopId };
    syntheticReq.authContext = auth;

    await new Promise<void>((resolve, reject) => {
      // Express Router exposes handle at runtime; typings omit it on the Router interface.
      (router as unknown as {
        handle: (req: AuthRequest, res: Response, next: (err?: unknown) => void) => void;
      }).handle(syntheticReq, res, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, error, "Failed to apply Conductor tool answer");
    }
  }
});

export default router;
