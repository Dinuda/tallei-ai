import { Router, type Response } from "express";
import { z } from "zod";
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  validateUIMessages,
  type UIMessage,
} from "ai";

import {
  allocateAgentAvatars,
  bindAgentAvatar,
  commitBuilderConnectorSetup,
  createWorkflowBuilderSession,
  dispatchWorkflowBuilderCommand,
  emptyLoopBuilderUsage,
  getBuilderConnectorSetup,
  getLoopSpec,
  getWorkflowBuilderCommand,
  listLoopSpecs,
  listWorkflowBuilderMessages,
  loopBuilderOpenAiModel,
  mergeLoopBuilderUsageTotals,
  normalizeSaveLoopInput,
  normalizeWorkflowBuilderMessages,
  refreshBuilderConnectorAvailability,
  recordWorkflowBuilderChatTurnTrace,
  replaceWorkflowBuilderMessages,
  requireWorkflowBuilderSession,
  resolveBuilderConnectorRequirement,
  retryFailedBuilderCommand,
  saveBuilderArtifactBundle,
  saveLoopRequestSchema,
  saveWorkflowBuilderAnalyzerUsage,
  setPendingPhaseRevision,
  startBuilderConnectorSetup,
  testBuilderConnectorSetup,
  clearPendingPhaseRevision,
  updateBuilderConnectorSetupGoals,
  updateBuilderConnectorSetupGraph,
  updateWorkflowBuilderSession,
  type LoopBuilderUsage,
} from "../../../services/conductor/index.js";
import { connectorAgentPlanSchema } from "../../../services/conductor/contracts/connector-setup.js";
import { invalidationPlan, requiresRegressionConfirmation } from "../../../services/conductor/builder/artifacts.js";
import { regressToPhase } from "../../../services/conductor/builder/regress.js";
import { classifyRevisionIntent } from "../../../services/conductor/contracts/intent-context.js";
import type { PendingPhaseRevision, PhaseTransitionEvent } from "../../../services/conductor/contracts/phase-history.js";
import { ensureBuilderProgressMessages } from "../../../services/conductor/builder/reasoning-stall.js";
import { loadSessionCommandUsage } from "../../../services/conductor/builder/turn-usage.js";
import { runBuilderTurn } from "../../../services/conductor/builder/turn-engine.js";
import { resolveLoopChatLanguageModel } from "../../../services/llm/loop-chat-client.js";
import { pool } from "../../../infrastructure/db/index.js";
import { loadWorkflowUserProfile } from "../../../services/conductor/domain/workflow-user-profile.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceMiddleware);

const chatSchema = z.object({
  sessionId: z.string().uuid().optional(),
  messages: z.array(z.unknown()).min(1),
});

function messageText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
}

router.post("/chat", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = chatSchema.parse(req.body ?? {});
    const messages = await validateUIMessages({
      messages: normalizeWorkflowBuilderMessages(body.messages),
    });
    const last = messages.at(-1);
    const firstUserText = messages.find((message) => message.role === "user");
    const text = messageText(last?.role === "user" ? last : firstUserText);
    if (!text && !body.sessionId) {
      res.status(400).json({ error: "A text message is required" });
      return;
    }
    const session = body.sessionId
      ? await requireWorkflowBuilderSession(req.authContext!, body.sessionId)
      : await createWorkflowBuilderSession(req.authContext!, text);
    const sessionId = session.id;
    const analyzerUsageBase = session.analyzerUsage ?? emptyLoopBuilderUsage();

    await replaceWorkflowBuilderMessages(req.authContext!, sessionId, messages);

    let activeSession = session;
    let revisionProposal: PendingPhaseRevision | null = null;
    let regressEvent: PhaseTransitionEvent | null = null;

    const lastUserMessage = last?.role === "user" ? last : undefined;
    if (lastUserMessage && text) {
      const revision = await classifyRevisionIntent({
        session: activeSession,
        userMessage: text,
        userMessageId: lastUserMessage.id,
      });
      if (revision.targetPhase) {
        const plan = invalidationPlan(revision.targetPhase);
        if (requiresRegressionConfirmation(plan)) {
          revisionProposal = {
            targetPhase: revision.targetPhase,
            revisedArtifact: revision.revisedArtifact,
            invalidated: plan.invalidated,
            preserved: plan.preserved,
            reason: revision.reason,
            userMessageId: lastUserMessage.id,
            proposedAt: new Date().toISOString(),
          };
          await setPendingPhaseRevision(req.authContext!, sessionId, revisionProposal);
        } else {
          const result = await regressToPhase(req.authContext!, sessionId, {
            targetPhase: revision.targetPhase,
            reason: "user_revision",
            userMessageId: lastUserMessage.id,
            revisedArtifact: revision.revisedArtifact ?? undefined,
          });
          activeSession = result.session;
          regressEvent = result.event;
        }
      }
    }

    const modelId = loopBuilderOpenAiModel();
    const model = resolveLoopChatLanguageModel(modelId);
    let completedTurnUsage = emptyLoopBuilderUsage();
    const abortController = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });
    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        writer.write({ type: "data-session", data: { sessionId }, transient: true });
        if (revisionProposal) {
          writer.write({ type: "data-phase-revision-proposal", data: revisionProposal, transient: true });
          return;
        }
        if (regressEvent) {
          writer.write({ type: "data-phase-regressed", data: regressEvent, transient: true });
        }
        const emitLiveUsage = async (runningTurnUsage: LoopBuilderUsage) => {
          const commandUsage = await loadSessionCommandUsage(req.authContext!, sessionId);
          writer.write({
            type: "data-usage",
            data: mergeLoopBuilderUsageTotals(analyzerUsageBase, runningTurnUsage, commandUsage),
            transient: true,
          });
        };
        completedTurnUsage = await runBuilderTurn({
          auth: req.authContext!,
          session: activeSession,
          model,
          modelId,
          uiMessages: messages,
          writer,
          analyzerUsageBase,
          abortSignal: abortController.signal,
        });
        await emitLiveUsage(completedTurnUsage);
        void (async () => {
          const commandUsage = await loadSessionCommandUsage(req.authContext!, sessionId);
          const sessionUsage = mergeLoopBuilderUsageTotals(analyzerUsageBase, completedTurnUsage);
          writer.write({
            type: "data-usage",
            data: mergeLoopBuilderUsageTotals(sessionUsage, commandUsage),
            transient: true,
          });
          await saveWorkflowBuilderAnalyzerUsage(req.authContext!, sessionId, sessionUsage);
        })();
      },
      onFinish: async ({ messages: completedMessages }) => {
        const activeSession = await requireWorkflowBuilderSession(req.authContext!, sessionId);
        const withFallback = ensureBuilderProgressMessages(completedMessages, activeSession);
        const patchedMessages = withFallback.map((message, index) => {
          if (index !== withFallback.length - 1 || message.role !== "assistant") return message;
          if (completedTurnUsage.promptTokens === 0 && completedTurnUsage.completionTokens === 0) return message;
          return {
            ...message,
            metadata: {
              ...(message.metadata ?? {}),
              usage: {
                promptTokens: completedTurnUsage.promptTokens,
                completionTokens: completedTurnUsage.completionTokens,
                totalTokens: completedTurnUsage.promptTokens + completedTurnUsage.completionTokens,
                estimatedCostUsd: completedTurnUsage.estimatedCostUsd,
              },
            },
          };
        });
        await replaceWorkflowBuilderMessages(req.authContext!, sessionId, patchedMessages);
        const commandUsage = await loadSessionCommandUsage(req.authContext!, sessionId);
        const turnUsage = mergeLoopBuilderUsageTotals(completedTurnUsage, commandUsage);
        if (turnUsage.calls > 0) {
          await recordWorkflowBuilderChatTurnTrace(req.authContext!, sessionId, {
            messageCount: patchedMessages.length,
            usage: turnUsage,
          });
        }
      },
      onError: (error) => error instanceof Error ? error.message : String(error),
    });
    pipeUIMessageStreamToResponse({ response: res, stream });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : /not available|requires|required|not found/i.test(error instanceof Error ? error.message : "") ? 409 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Failed to process builder chat" });
  }
});

router.put("/sessions/:sessionId/messages", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ messages: z.array(z.unknown()) }).parse(req.body ?? {});
    await requireWorkflowBuilderSession(req.authContext!, sessionId);
    await replaceWorkflowBuilderMessages(
      req.authContext!,
      sessionId,
      await validateUIMessages({ messages: normalizeWorkflowBuilderMessages(body.messages) }),
    );
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save builder messages";
    res.status(error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/revision/confirm", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ approved: z.boolean() }).parse(req.body ?? {});
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    if (!session.pendingRevision) {
      res.status(409).json({ error: "No pending phase revision proposal" });
      return;
    }
    if (!body.approved) {
      await clearPendingPhaseRevision(req.authContext!, sessionId);
      res.json({ ok: true, approved: false });
      return;
    }
    const pending = session.pendingRevision;
    const result = await regressToPhase(req.authContext!, sessionId, {
      targetPhase: pending.targetPhase,
      reason: "user_revision_confirmed",
      userMessageId: pending.userMessageId,
      revisedArtifact: pending.revisedArtifact ?? undefined,
    });
    await clearPendingPhaseRevision(req.authContext!, sessionId);
    res.json({
      ok: true,
      approved: true,
      session: result.session,
      event: result.event,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to confirm phase revision";
    res.status(error instanceof z.ZodError ? 400 : /not found|no pending/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.get("/sessions/:sessionId/revision/pending", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    res.json({ pending: session.pendingRevision });
  } catch (error) {
    res.status(error instanceof z.ZodError ? 400 : 404).json({ error: error instanceof Error ? error.message : "Builder session not found" });
  }
});

router.post("/sessions/:sessionId/retry-command", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ commandId: z.string().uuid().optional() }).parse(req.body ?? {});
    const command = await retryFailedBuilderCommand(req.authContext!, sessionId, body.commandId);
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to retry builder command";
    res.status(error instanceof z.ZodError ? 400 : /not found|no failed/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.get("/sessions/:sessionId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    const rawMessages = await listWorkflowBuilderMessages(req.authContext!, sessionId);
    let messages = rawMessages.length > 0 ? await validateUIMessages({ messages: rawMessages }) : [];
    const patchedMessages = ensureBuilderProgressMessages(messages, session);
    if (JSON.stringify(patchedMessages) !== JSON.stringify(messages)) {
      await replaceWorkflowBuilderMessages(req.authContext!, sessionId, patchedMessages);
      messages = patchedMessages;
    }
    const commandsResult = await pool.query(
      `SELECT id, tool_name, status, input_json, events_json, usage_json, result_json, error_text, created_at, updated_at
       FROM workflow_builder_commands
       WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
       ORDER BY created_at ASC`,
      [sessionId, req.authContext!.tenantId, req.authContext!.userId],
    );
    const commands = commandsResult.rows.map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      status: row.status,
      input: row.input_json ?? {},
      events: row.events_json ?? [],
      usage: row.usage_json ?? {},
      result: row.result_json ?? undefined,
      error: row.error_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const turnsResult = await pool.query(
      `SELECT id, session_revision, state, status, events_json, error_text, created_at, updated_at
       FROM workflow_builder_turns
       WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
       ORDER BY created_at ASC`,
      [sessionId, req.authContext!.tenantId, req.authContext!.userId],
    );
    const actionsResult = await pool.query(
      `SELECT id, turn_id, action_id, state, action_name, action_kind, schema_version,
              status, input_json, output_json, error_text, expected_revision, created_at, updated_at
       FROM workflow_builder_actions
       WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
       ORDER BY created_at ASC`,
      [sessionId, req.authContext!.tenantId, req.authContext!.userId],
    );
    const turns = turnsResult.rows.map((row) => ({
      id: row.id,
      sessionRevision: row.session_revision,
      state: row.state,
      status: row.status,
      events: row.events_json ?? [],
      error: row.error_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const actions = actionsResult.rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      actionId: row.action_id,
      state: row.state,
      actionName: row.action_name,
      actionKind: row.action_kind,
      schemaVersion: row.schema_version,
      status: row.status,
      input: row.input_json ?? {},
      output: row.output_json ?? undefined,
      error: row.error_text,
      expectedRevision: row.expected_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const profile = await loadWorkflowUserProfile(req.authContext!).catch(() => null);
    const recalledPreferences = (profile?.memories ?? []).map((memory) => ({
      id: memory.id,
      text: memory.text.slice(0, 200),
      category: memory.category ?? null,
    }));
    res.json({ session, messages, commands, turns, actions, recalledPreferences });
  } catch (error) {
    res.status(error instanceof z.ZodError ? 400 : 404).json({ error: error instanceof Error ? error.message : "Builder session not found" });
  }
});

router.post("/sessions/:sessionId/connectors/refresh", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    res.json({ checklist: await refreshBuilderConnectorAvailability(req.authContext!, sessionId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh connector availability";
    res.status(error instanceof z.ZodError ? 400 : /not found|no connector requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/connectors/resolve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    res.json(await resolveBuilderConnectorRequirement(req.authContext!, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve connector requirement";
    res.status(error instanceof z.ZodError ? 400 : /not found|no connector requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/connectors/setup/start", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    res.json(await startBuilderConnectorSetup(req.authContext!, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start connector setup";
    res.status(error instanceof z.ZodError ? 400 : /not found|no connector requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.get("/sessions/:sessionId/connectors/setup", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    res.json(await getBuilderConnectorSetup(req.authContext!, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load connector setup";
    res.status(error instanceof z.ZodError ? 400 : /not found|no connector requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/connectors/setup/update-goals", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ agentPlan: connectorAgentPlanSchema }).parse(req.body ?? {});
    res.json(await updateBuilderConnectorSetupGoals(req.authContext!, sessionId, body.agentPlan));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update connector goals";
    res.status(error instanceof z.ZodError ? 400 : /not found|not been started/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/connectors/setup/update-graph", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ agentPlan: connectorAgentPlanSchema }).parse(req.body ?? {});
    res.json(await updateBuilderConnectorSetupGraph(req.authContext!, sessionId, body.agentPlan));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update connector graph";
    res.status(error instanceof z.ZodError ? 400 : /not found|not been started/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/connectors/setup/test", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ skip: z.boolean().optional() }).parse(req.body ?? {});
    res.json(await testBuilderConnectorSetup(req.authContext!, sessionId, body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to test connector setup";
    res.status(error instanceof z.ZodError ? 400 : /not found|not been started/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/connectors/setup/commit", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    res.json(await commitBuilderConnectorSetup(req.authContext!, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to commit connector setup";
    res.status(error instanceof z.ZodError ? 400 : /not found|not been started/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/artifacts/save", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({
      requirementId: z.string().min(1).default("artifact_contract"),
      value: z.object({
        mode: z.literal("supplied_template"),
        template: z.string().min(1),
      }),
      messages: z.array(z.unknown()).optional(),
    }).parse(req.body ?? {});
    const result = await saveBuilderArtifactBundle(req.authContext!, sessionId, {
      requirementId: body.requirementId,
      value: body.value,
    });
    if (body.messages) {
      await replaceWorkflowBuilderMessages(
        req.authContext!,
        sessionId,
        await validateUIMessages({ messages: normalizeWorkflowBuilderMessages(body.messages) }),
      );
    }
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save artifact templates";
    res.status(error instanceof z.ZodError ? 400 : /not found|no build contract/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.get("/sessions/:sessionId/schedule-options", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    const requirement = session.buildContract?.requirements.find((entry) => entry.kind === "trigger_schedule");
    if (!requirement) throw new Error("This builder session has no trigger requirement.");
    res.json({ requirementId: requirement.id, capabilities: requirement.triggerCapabilities ?? { minimumScheduleMinutes: 60, events: [] } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load schedule options";
    res.status(error instanceof z.ZodError ? 400 : /not found|no trigger requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.get("/jobs/:jobId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const command = await getWorkflowBuilderCommand(req.authContext!, z.string().uuid().parse(req.params.jobId));
    if (!command) return void res.status(404).json({ error: "Loop builder job not found" });
    res.json(command);
  } catch (error) {
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : "Failed to read loop builder job" });
  }
});

router.post("/save", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = saveLoopRequestSchema.parse(req.body ?? {});
    const command = await dispatchWorkflowBuilderCommand({
      auth: req.authContext!, sessionId: body.sessionId, toolName: "saveLoop",
      input: { ...normalizeSaveLoopInput(body), approved: true },
    });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save loop";
    res.status(error instanceof z.ZodError ? 400 : 409).json({ error: message });
  }
});

router.get("/specs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const specs = await listLoopSpecs(req.authContext!);
    res.json({ specs });
  } catch (error) {
    console.error("Error listing loop specs:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list loop specs" });
  }
});

router.get("/specs/:specId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { specId } = z.object({ specId: z.string().uuid() }).parse(req.params);
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

router.patch("/sessions/:sessionId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body ?? {});
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    const patch: Parameters<typeof updateWorkflowBuilderSession>[2] = {
      title: body.title,
      goal: body.title,
    };
    if (session.currentProposal) {
      patch.currentProposal = { ...session.currentProposal, title: body.title };
    }
    const updated = await updateWorkflowBuilderSession(req.authContext!, sessionId, patch);
    res.json({ session: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update builder session";
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: message });
  }
});

router.post("/agent-avatars/allocate", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({ count: z.number().int().min(1).max(20).optional() }).parse(req.body ?? {});
    const avatars = await allocateAgentAvatars(req.authContext!, body.count ?? 1);
    res.json({ avatars });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to allocate avatars";
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: message });
  }
});

router.post("/agent-avatars/:avatarId/bind", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const avatarId = z.string().uuid().parse(req.params.avatarId);
    const body = z.object({
      specId: z.string().uuid(),
      agentId: z.string().min(1).trim(),
    }).parse(req.body ?? {});
    const avatar = await bindAgentAvatar(req.authContext!, avatarId, body);
    res.json({ avatar });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to bind avatar";
    const status = message.includes("not found") ? 404 : message.includes("already bound") ? 409 : error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
