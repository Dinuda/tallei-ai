import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuthContext } from "../../../domain/auth/index.js";
import { hasRequiredScopes } from "../../../infrastructure/auth/oauth-tokens.js";
import {
  saveMemory,
  savePreference,
  listMemories,
  listPreferences,
  forgetPreference,
  deleteMemory,
  QuotaExceededError,
} from "../../../services/memory.js";
import {
  stashDocument,
  createLot,
  DocumentSizeExceededError,
} from "../../../services/documents.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import {
  attachUploadedFilesToTaskContext,
  buildFirstTurnContinueCommand,
  buildTurnFallbackContext,
  CollabAttachmentIngestError,
  claimTurn,
  CollabConflictError,
  createTask as createCollabTask,
  getTask as getCollabTask,
  hydrateTaskWithRecentPreparedUploads,
  inlineDocumentsFromTaskContext,
  listTasks as listCollabTasks,
  submitTurn as submitCollabTurn,
} from "../../../services/collab.js";
import {
  approvePlan as approveOrchestratorPlan,
  buildSessionFallbackContext,
  OrchestrationConflictError,
  OrchestrationInvalidPlanError,
  OrchestrationNotFoundError,
  startSession as startOrchestratorSession,
  submitAnswers as submitOrchestratorAnswers,
} from "../../../services/orchestrator.js";
import { PlatformSchema } from "../schemas.js";
import { conversationIdSchema, normalizeUploadedFileRequestBody, openAiFileRefSchema } from "../../http/schemas/uploaded-files.js";
import {
  executeRecallAction,
  executeRecallDocumentAction,
  executeRecentDocumentsAction,
  executeRememberAction,
  executeSearchDocumentsAction,
  executeUndoSaveAction,
  executeUploadBlobAction,
  executeUploadStatusAction,
} from "../../shared/chat-actions.js";

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };
const MemoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note"]);

function onQuotaError(err: unknown): ToolResult {
  if (err instanceof QuotaExceededError) {
    return { content: [{ type: "text", text: `⚠️ ${err.message}` }], isError: true };
  }
  throw err;
}

function onPlanError(err: unknown): ToolResult {
  if (err instanceof PlanRequiredError) {
    return {
      content: [{
        type: "text",
        text: `⚠️ ${err.message} Ask the user to complete payment, then retry document sharing.`,
      }],
      isError: true,
    };
  }
  throw err;
}

function onKnownError(err: unknown): ToolResult {
  try {
    return onPlanError(err);
  } catch (planErr) {
    return onQuotaError(planErr);
  }
}

function toJsonToolResult(body: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function appendContinueCommand(
  userVisible: string,
  command: ReturnType<typeof buildFirstTurnContinueCommand>
): string {
  if (!command) return userVisible;
  return `${userVisible}\n\n${command.instruction}`;
}

function roleSelectionUserVisible(roleSelection: {
  chatgpt_role: string;
  claude_role: string;
  first_actor_recommendation: string;
  selected_first_actor: string;
}): string {
  return [
    "Before grill-me starts, here is the provider role split. Show each provider prompt as a fenced code block so it is visually distinct:",
    "ChatGPT system prompt:",
    "```text",
    roleSelection.chatgpt_role,
    "```",
    "Claude system prompt:",
    "```text",
    roleSelection.claude_role,
    "```",
    `Recommended first actor: ${roleSelection.first_actor_recommendation}`,
    `Selected first actor: ${roleSelection.selected_first_actor}`,
  ].join("\n");
}

function hasCollabWriteScope(auth: AuthContext): boolean {
  if (auth.authMode === "internal" || auth.authMode === "api_key") return true;
  return hasRequiredScopes(auth.scopes ?? [], ["collab:write"]);
}

function hasOrchestrateScope(auth: AuthContext): boolean {
  if (auth.authMode === "internal" || auth.authMode === "api_key") return true;
  return hasRequiredScopes(auth.scopes ?? [], ["orchestrate:write"]);
}

export function registerTools(server: McpServer, auth: AuthContext): void {
  server.registerTool(
    "save_memory",
    {
      title: "Save Memory",
      description: "Prefer the `remember` tool — it handles facts, preferences, and document notes in one call. This tool exists for backward compatibility.",
      inputSchema: {
        content: z
          .string()
          .describe("The fact, preference, or information to remember. Be specific and concise."),
        platform: PlatformSchema.optional().default("claude").describe("The AI platform this memory is from"),
      },
    },
    async ({ content, platform }) => {
      try {
        const saved = await saveMemory(content, auth, platform ?? "claude");
        return { content: [{ type: "text", text: `✅ Memory saved (${saved.memoryId}).` }] };
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "save_preference",
    {
      title: "Save Preference",
      description: "Prefer the `remember` tool with kind=\"preference\". This exists for backward compatibility.",
      inputSchema: {
        content: z
          .string()
          .describe("The preference to store (e.g., favorite color, preferred stack, name/pronouns)."),
        category: z.string().optional().describe("Optional preference category like identity, ui, stack."),
        preference_key: z
          .string()
          .optional()
          .describe("Optional stable conflict key (e.g., favorite_color, identity_name)."),
        platform: PlatformSchema.optional().default("claude").describe("The AI platform this preference is from"),
      },
    },
    async ({ content, category, preference_key, platform }) => {
      try {
        const saved = await savePreference(content, auth, platform ?? "claude", undefined, {
          category: category ?? null,
          preferenceKey: preference_key ?? null,
        });
        return { content: [{ type: "text", text: `✅ Preference saved (${saved.memoryId}).` }] };
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "recall_memories",
    {
      title: "Recall Memories",
      description:
        "Searches Tallei persistent memory and returns relevant past context. " +
        "Call ONLY when the user explicitly references prior sessions, asks about their preferences, or the task requires personalized past context. " +
        "Do NOT call this before answering — answer first, then recall if needed. " +
        "Pinned preferences are already available as the 'Pinned Preferences' MCP resource; do not recall them here.",
      inputSchema: {
        query: z
          .string()
          .describe("What to search for. Use topic keywords like 'favorite food' or 'project stack'."),
        limit: z.number().int().min(1).max(20).optional().default(5),
        types: z.array(MemoryTypeSchema).optional().describe("Optional type filter for scoped recall."),
        include_doc_refs: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Optional @doc/@lot refs to append brief document metadata."),
        openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
        conversation_id: conversationIdSchema,
      },
    },
    async (args) => {
      try {
        const parsed = z.object({
          query: z.string(),
          limit: z.number().int().min(1).max(20).optional().default(5),
          types: z.array(MemoryTypeSchema).optional(),
          include_doc_refs: z.array(z.string()).max(20).optional(),
          openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
          conversation_id: conversationIdSchema,
        }).parse(normalizeUploadedFileRequestBody(args));

        const result = await executeRecallAction(auth, {
          query: parsed.query,
          limit: parsed.limit,
          types: parsed.types,
          include_doc_refs: parsed.include_doc_refs,
          openaiFileIdRefs: parsed.openaiFileIdRefs,
          conversation_id: parsed.conversation_id ?? null,
        });
        return toJsonToolResult(result.body, result.status >= 400);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "collab_check_turn",
    {
      title: "Check Claude Collab Turn",
      description: "Checks if it's Claude's turn on a collab task and returns task context.",
      inputSchema: {
        task_id: z.string().uuid().describe("Collab task ID."),
        openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
        conversation_id: conversationIdSchema,
      },
    },
    async ({ task_id, openaiFileIdRefs, conversation_id }) => {
      try {
        if (!hasCollabWriteScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["collab:write"] }, true);
        }

        const claimed = await claimTurn(task_id, "claude", auth);
        let task = claimed ?? await getCollabTask(task_id, auth);
        if (!task) {
          return toJsonToolResult({ error: "Task not found" }, true);
        }
        let uploadSummary = openaiFileIdRefs?.length
          ? await attachUploadedFilesToTaskContext(task.id, auth, {
            openaiFileIdRefs,
            conversationId: conversation_id ?? null,
          })
          : null;
        const preparedUploadHydration = uploadSummary
          ? null
          : await hydrateTaskWithRecentPreparedUploads(task, auth, {
            conversationId: conversation_id ?? null,
          });
        if (preparedUploadHydration) uploadSummary = preparedUploadHydration.attached;
        if (uploadSummary) {
          task = await getCollabTask(task.id, auth) ?? task;
        }
        const inlineDocuments = await inlineDocumentsFromTaskContext(task, auth);

        const lastChatGptEntry = [...task.transcript].reverse().find((entry) => entry.actor === "chatgpt") ?? null;
        const nextActor = task.iteration >= task.maxIterations
          ? null
          : task.state === "CREATIVE"
            ? "chatgpt"
            : task.state === "TECHNICAL"
              ? "claude"
              : null;
        const continueCommand = buildFirstTurnContinueCommand(task);
        return toJsonToolResult({
          is_my_turn: Boolean(claimed),
          task_id: task.id,
          title: task.title,
          state: task.state,
          iteration: task.iteration,
          max_iterations: task.maxIterations,
          next_actor: nextActor,
          user_visible: appendContinueCommand(claimed
            ? `It's your turn on task ${task.id} (iteration ${task.iteration + 1}).`
            : `Task ${task.id} is waiting on ${nextActor ?? "completion"}.`, continueCommand),
          continue_command: continueCommand,
          brief: task.brief,
          last_chatgpt_entry: lastChatGptEntry,
          recent_transcript: task.transcript.slice(-6),
          fallback_context: buildTurnFallbackContext(task, "claude"),
          ...(inlineDocuments.length ? { inline_documents: inlineDocuments } : {}),
          ...(uploadSummary ? { upload: uploadSummary } : {}),
        });
      } catch (err) {
        if (err instanceof CollabAttachmentIngestError) {
          return toJsonToolResult({
            error: err.message,
            count_saved: 0,
            count_failed: err.errors.length,
            errors: err.errors,
          }, true);
        }
        const message = err instanceof Error ? err.message : "Failed to check turn";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    "collab_take_turn",
    {
      title: "Submit Claude Collab Turn",
      description: "Submits Claude's content for a collab task turn.",
      inputSchema: {
        task_id: z.string().uuid().describe("Collab task ID."),
        content: z.string().min(1).describe("Turn output content."),
        openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
        conversation_id: conversationIdSchema,
      },
    },
    async ({ task_id, content, openaiFileIdRefs, conversation_id }) => {
      try {
        if (!hasCollabWriteScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["collab:write"] }, true);
        }
        const uploadSummary = openaiFileIdRefs?.length
          ? await attachUploadedFilesToTaskContext(task_id, auth, {
            openaiFileIdRefs,
            conversationId: conversation_id ?? null,
          })
          : null;
        const task = await submitCollabTurn(task_id, "claude", content, auth);
        const nextActor = task.iteration >= task.maxIterations
          ? null
          : task.state === "CREATIVE"
            ? "chatgpt"
            : task.state === "TECHNICAL"
              ? "claude"
              : null;
        const savedTurn = task.transcript.length > 0 ? task.transcript[task.transcript.length - 1] : null;
        const continueCommand = buildFirstTurnContinueCommand(task);
        return toJsonToolResult({
          ok: true,
          task_id: task.id,
          state: task.state,
          iteration: task.iteration,
          max_iterations: task.maxIterations,
          next_actor: nextActor,
          user_visible: appendContinueCommand(`Saved Claude turn for task ${task.id} at iteration ${task.iteration}.`, continueCommand),
          continue_command: continueCommand,
          saved_turn: savedTurn
            ? {
                actor: savedTurn.actor,
                iteration: savedTurn.iteration,
                ts: savedTurn.ts,
                content: savedTurn.content,
                content_length: savedTurn.content.length,
                content_preview: savedTurn.content.slice(0, 800),
              }
            : null,
          ...(uploadSummary ? { upload: uploadSummary } : {}),
        });
      } catch (err) {
        if (err instanceof CollabAttachmentIngestError) {
          return toJsonToolResult({
            error: err.message,
            count_saved: 0,
            count_failed: err.errors.length,
            errors: err.errors,
          }, true);
        }
        if (err instanceof CollabConflictError) {
          const task = await getCollabTask(task_id, auth);
          const nextActor = task
            ? (
              task.iteration >= task.maxIterations
                ? null
                : task.state === "CREATIVE"
                  ? "chatgpt"
                  : task.state === "TECHNICAL"
                    ? "claude"
                    : null
            )
            : null;
          return toJsonToolResult({
            ok: false,
            error: err.message,
            task_id,
            state: task?.state ?? null,
            iteration: task?.iteration ?? null,
            max_iterations: task?.maxIterations ?? null,
            next_actor: nextActor,
            user_visible: task
              ? `Turn rejected. Task ${task.id} is currently waiting on ${nextActor ?? "completion"}.`
              : "Turn rejected due to task state mismatch.",
            fallback_context: task ? buildTurnFallbackContext(task, "claude") : null,
          }, true);
        }
        const message = err instanceof Error ? err.message : "Failed to submit turn";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    "collab_list_pending",
    {
      title: "List Pending Collab Tasks",
      description: "Lists collab tasks currently waiting on Claude.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!hasCollabWriteScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["collab:write"] }, true);
        }
        const tasks = await listCollabTasks({ filter: "waiting" }, auth);
        return toJsonToolResult({ tasks: tasks.filter((task) => task.state === "TECHNICAL") });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to list collab tasks";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    "collab_create_task",
    {
      title: "Create Collab Task",
      description: "Creates a new collab task for ChatGPT and Claude turn-taking. Performs recall preflight (supports include_doc_refs) before creation and returns preflight context.",
      inputSchema: {
        title: z.string().min(1).describe("Task title."),
        brief: z.string().optional().describe("Optional task brief."),
        first_actor: z.enum(["chatgpt", "claude"]).optional().default("chatgpt").describe("Which model takes the first turn."),
        openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
        include_doc_refs: z.array(z.string()).max(20).optional(),
        recall_query: z.string().min(1).max(500).optional(),
        conversation_id: conversationIdSchema,
      },
    },
    async (args) => {
      try {
        const parsed = z.object({
          title: z.string().min(1),
          brief: z.string().optional(),
          first_actor: z.enum(["chatgpt", "claude"]).optional().default("chatgpt"),
          openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
          include_doc_refs: z.array(z.string()).max(20).optional(),
          recall_query: z.string().min(1).max(500).optional(),
          conversation_id: conversationIdSchema,
        }).parse(normalizeUploadedFileRequestBody(args));
        if (!hasCollabWriteScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["collab:write"] }, true);
        }
        const recallQuery = parsed.recall_query ?? parsed.brief ?? parsed.title;
        const preflightRecall = await executeRecallAction(auth, {
          query: recallQuery,
          limit: 5,
          include_doc_refs: parsed.include_doc_refs,
          openaiFileIdRefs: parsed.openaiFileIdRefs,
          conversation_id: parsed.conversation_id ?? null,
        });
        const createdTask = await createCollabTask(
          {
            title: parsed.title,
            brief: parsed.brief ?? null,
            firstActor: parsed.first_actor ?? "chatgpt",
            context: {
              preflight_recall: preflightRecall.status === 200
                ? {
                  query: recallQuery,
                  context_block: preflightRecall.body.contextBlock,
                  memories_count: preflightRecall.body.memories.length,
                  matched_documents_count: preflightRecall.body.matchedDocuments.length,
                  referenced_documents_count: preflightRecall.body.referencedDocuments.length,
                  auto_save: preflightRecall.body.autoSave,
                }
                : {
                  query: recallQuery,
                  error: preflightRecall.body.error,
                  auto_save: preflightRecall.body.autoSave,
                },
            },
          },
          auth
        );
        let uploadSummary:
          | {
            lot_ref: string | null;
            count_saved: number;
            count_attached_existing: number;
            count_total_documents: number;
            count_failed: number;
            errors: Array<{ file_id: string; filename: string; error: string }>;
          }
          | null = null;
        if (parsed.openaiFileIdRefs?.length) {
          try {
            uploadSummary = await attachUploadedFilesToTaskContext(createdTask.id, auth, {
              openaiFileIdRefs: parsed.openaiFileIdRefs,
              conversationId: parsed.conversation_id ?? null,
              title: parsed.title,
            });
          } catch (error) {
            if (error instanceof CollabAttachmentIngestError) {
              uploadSummary = {
                lot_ref: null,
                count_saved: 0,
                count_attached_existing: 0,
                count_total_documents: 0,
                count_failed: error.errors.length,
                errors: error.errors,
              };
            } else {
              throw error;
            }
          }
        }
        const task = (parsed.openaiFileIdRefs?.length ? await getCollabTask(createdTask.id, auth) : createdTask) ?? createdTask;
        const continueCommand = buildFirstTurnContinueCommand(task);
        return toJsonToolResult({
          ok: true,
          task_id: task.id,
          title: task.title,
          brief: task.brief,
          state: task.state,
          iteration: task.iteration,
          max_iterations: task.maxIterations,
          next_actor: task.iteration >= task.maxIterations
            ? null
            : task.state === "CREATIVE"
              ? "chatgpt"
              : task.state === "TECHNICAL"
                ? "claude"
                : null,
          fallback_context: buildTurnFallbackContext(task, "claude"),
          preflight_recall: preflightRecall.body,
          ...(uploadSummary ? { upload: uploadSummary } : {}),
          user_visible: appendContinueCommand(`Created collab task ${task.id} (${task.title}).`, continueCommand),
          continue_command: continueCommand,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create collab task";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    "orchestrator_start",
    {
      title: "Start Orchestration Session",
      description: "Starts grill-me planning for a goal and returns the first planner question.",
      inputSchema: {
        goal: z.string().min(1).describe("The goal to plan before collab execution."),
        first_actor_preference: z.enum(["chatgpt", "claude"]).optional(),
        initial_context: z.string().optional(),
      },
    },
    async ({ goal, first_actor_preference, initial_context }) => {
      try {
        if (!hasOrchestrateScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["orchestrate:write"] }, true);
        }
        const result = await startOrchestratorSession(
          {
            goal,
            sourcePlatform: "claude",
            firstActorPreference: first_actor_preference,
            initialContext: initial_context ?? null,
          },
          auth
        );
        return toJsonToolResult({
          session_id: result.session.id,
          status: result.session.status,
          question: result.firstQuestion,
          question_payload: result.firstQuestionData ?? { question: result.firstQuestion },
          role_suggestion: result.roleSelection,
          user_visible: result.firstQuestion
            ? `${roleSelectionUserVisible(result.roleSelection)}\n\nFirst grill-me question: ${result.firstQuestion}\n\nStop here and wait for the user's answer or approval to use the default/recommended answer.`
            : `${roleSelectionUserVisible(result.roleSelection)}\n\nThe grill-me plan is ready for review. Stop here and wait for explicit user approval before calling orchestrator_approve.`,
          next_instruction: "Show the role split and first grill-me question to the user, then stop. Do not call orchestrator_answer until the user explicitly answers or approves using the displayed default/recommended answer.",
          fallback_context: buildSessionFallbackContext(result.session),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to start orchestration session";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    "orchestrator_answer",
    {
      title: "Continue Orchestration Session",
      description: "Submits one or more user answers for orchestration and returns next question or plan.",
      inputSchema: {
        session_id: z.string().uuid().describe("Orchestration session ID."),
        answer: z.string().min(1).optional().describe("Single user answer. Use 'continue' to accept the displayed default/recommended answer and finalize."),
        answers: z.array(z.string().min(1)).min(1).max(5).optional().describe("Batch of explicit user answers to process in order."),
        auto_continue: z.boolean().optional().default(false).describe("When true, keep accepting default/recommended answers until plan_ready or max_steps is reached."),
        max_steps: z.number().int().min(1).max(5).optional().default(3).describe("Maximum planner steps to process in this request."),
      },
    },
    async ({ session_id, answer, answers, auto_continue, max_steps }) => {
      try {
        if (!hasOrchestrateScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["orchestrate:write"] }, true);
        }
        const answerBatch = answers ?? (answer ? [answer] : []);
        if (answerBatch.length === 0) {
          return toJsonToolResult({ error: "answer or answers is required", session_id }, true);
        }
        const shouldAutoContinue = Boolean(auto_continue) || answerBatch.some((value) => /^continue$/i.test(value.trim()));
        const result = await submitOrchestratorAnswers(session_id, answerBatch, auth, {
          autoContinue: shouldAutoContinue,
          maxSteps: max_steps,
        });
        return toJsonToolResult({
          session_id,
          status: result.session.status,
          question: result.nextQuestion ?? null,
          question_payload: result.nextQuestionData ?? (result.nextQuestion ? { question: result.nextQuestion } : null),
          plan: result.plan ?? result.session.plan,
          steps_processed: result.stepsProcessed,
          user_visible: result.planReady
            ? `I processed ${result.stepsProcessed} grill-me step${result.stepsProcessed === 1 ? "" : "s"}. The plan is ready for review. Stop here and wait for explicit user approval before calling orchestrator_approve.`
            : `I processed ${result.stepsProcessed} grill-me step${result.stepsProcessed === 1 ? "" : "s"}. Next grill-me question: ${result.nextQuestion ?? "continue with the recommended/default answer."}\n\nStop here and wait for the user's answer or approval to use the default/recommended answer.`,
          next_instruction: result.planReady
            ? "Show the plan for review, then stop. Do not call orchestrator_approve until the user explicitly approves the plan."
            : "Show the next grill-me question, then stop. Do not call orchestrator_answer again until the user explicitly answers or approves using the displayed default/recommended answer.",
          fallback_context: buildSessionFallbackContext(result.session),
        });
      } catch (err) {
        if (err instanceof OrchestrationConflictError || err instanceof OrchestrationNotFoundError) {
          return toJsonToolResult({ error: err.message, session_id }, true);
        }
        const message = err instanceof Error ? err.message : "Failed to continue orchestration session";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    "orchestrator_approve",
    {
      title: "Approve Orchestration Plan",
      description: "Approves the prepared orchestration plan and creates the linked collab task.",
      inputSchema: {
        session_id: z.string().uuid().describe("Orchestration session ID."),
        overrides: z.object({
          first_actor: z.enum(["chatgpt", "claude"]).optional(),
        }).optional(),
      },
    },
    async ({ session_id, overrides }) => {
      try {
        if (!hasOrchestrateScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["orchestrate:write"] }, true);
        }
        if (!hasCollabWriteScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["collab:write"] }, true);
        }
        const result = await approveOrchestratorPlan(session_id, auth, overrides);
        return toJsonToolResult({
          task_id: result.task.id,
          plan_summary: result.session.plan?.summary ?? result.task.brief ?? "",
          success_criteria: result.session.plan?.success_criteria ?? [],
          first_actor: result.session.plan?.first_actor ?? "chatgpt",
          next_instruction: `Collab task ${result.task.id} is ready. Continue with collab_check_turn/collab_take_turn for the selected first actor.`,
          fallback_context: result.session ? buildSessionFallbackContext(result.session) : null,
        });
      } catch (err) {
        if (
          err instanceof OrchestrationConflictError ||
          err instanceof OrchestrationNotFoundError ||
          err instanceof OrchestrationInvalidPlanError
        ) {
          return toJsonToolResult({ error: err.message, session_id }, true);
        }
        const message = err instanceof Error ? err.message : "Failed to approve orchestration plan";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    "list_preferences",
    {
      title: "List Preferences",
      description: "Lists pinned and active user preferences.",
      inputSchema: {},
    },
    async () => {
      const preferences = await listPreferences(auth);
      if (preferences.length === 0) {
        return { content: [{ type: "text", text: "No preferences stored yet." }] };
      }
      const text = preferences
        .map((preference) => `• ${preference.text} (id=${preference.id})`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "forget_preference",
    {
      title: "Forget Preference",
      description: "Deletes a preference memory by ID.",
      inputSchema: {
        preference_id: z.string().describe("Preference memory ID"),
      },
    },
    async ({ preference_id }) => {
      try {
        const result = await forgetPreference(preference_id, auth);
        return { content: [{ type: "text", text: `Deleted preference ${preference_id}. Success: ${result.success}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete preference";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "list_memories",
    {
      title: "List Memories",
      description: "Lists all recent memories stored in Tallei for this user.",
      inputSchema: {},
    },
    async () => {
      const memories = await listMemories(auth);
      if (memories.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }
      return { content: [{ type: "text", text: memories.map((m) => `• ${m.text}`).join("\n") }] };
    }
  );

  server.registerTool(
    "delete_memory",
    {
      title: "Delete Memory",
      description: "Deletes a specific memory from Tallei by its ID.",
      inputSchema: {
        memory_id: z.string().describe("The unique ID of the memory to delete"),
      },
    },
    async ({ memory_id }) => {
      const result = await deleteMemory(memory_id, auth);
      return { content: [{ type: "text", text: `Deleted memory ${memory_id}. Success: ${result.success}` }] };
    }
  );

  server.registerTool(
    "stash_document",
    {
      title: "Stash Document Full Blob",
      description:
        "HEAVY: Requires emitting the entire document as the `content` argument. " +
        "Prefer remember(kind=\"document-note\") for most 'save this document' requests — it needs no content field. " +
        "Only use this when the user explicitly says to archive or store the full file for future retrieval. " +
        "Call AFTER finishing your user response. Indexing runs in the background. Pro feature.",
      inputSchema: {
        content: z.string().min(1).describe("Full document markdown/text to store verbatim."),
        filename: z.string().optional().describe("Optional source filename."),
        title: z.string().optional().describe("Optional display title."),
      },
    },
    async ({ content, filename, title }) => {
      try {
        const stashed = await stashDocument(content, auth, { filename: filename ?? undefined, title: title ?? undefined });
        const lotSuffix = stashed.lotRef ? ` Auto-lot: ${stashed.lotRef}.` : "";
        return {
          content: [{
            type: "text",
            text: `✅ Document stashed as ${stashed.refHandle}. Status: ${stashed.status}.${lotSuffix}`,
          }],
        };
      } catch (err) {
        if (err instanceof DocumentSizeExceededError) {
          return { content: [{ type: "text", text: `⚠️ ${err.message}` }], isError: true };
        }
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "create_lot",
    {
      title: "Create Lot",
      description: "Groups existing stashed documents under one @lot handle for multi-file recall. Pro feature.",
      inputSchema: {
        refs: z.array(z.string()).min(1).describe("Array of @doc:... references to group."),
        title: z.string().optional().describe("Optional lot title."),
      },
    },
    async ({ refs, title }) => {
      try {
        const lot = await createLot(refs, auth, title ?? undefined);
        return {
          content: [{
            type: "text",
            text: `✅ Lot created ${lot.lotRef} with ${lot.docRefs.length} document(s): ${lot.docRefs.join(", ")}`,
          }],
        };
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "recall_document",
    {
      title: "Recall Document",
      description:
        "Returns the complete stored document markdown for an @doc ref, or all full docs for an @lot ref. " +
        "May be large: use only when the user clearly needs the full file. Pro feature.",
      inputSchema: {
        ref: z.string().min(1).describe("Document or lot reference, e.g. @doc:... or @lot:..."),
      },
    },
    async ({ ref }) => {
      try {
        const result = await executeRecallDocumentAction(auth, ref);
        return toJsonToolResult(result.body);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "search_documents",
    {
      title: "Search Documents",
      description:
        "Vector-searches stashed document summaries and returns matching refs for discovery. " +
        "Does not return full content. Pro feature.",
      inputSchema: {
        query: z.string().min(1).describe("Search query to find relevant documents."),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
    },
    async ({ query, limit }) => {
      try {
        const result = await executeSearchDocumentsAction(auth, query, limit ?? 5);
        return toJsonToolResult(result.body);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  // Unified entry point — the preferred tool for all save operations.
  server.registerTool(
    "remember",
    {
      title: "Save / Stash to Memory (remember)",
      description:
        "Save a memory, save a preference, or stash a document to Tallei persistent memory. " +
        "Use this for explicit save requests AND required auto-save of newly processed structured content. " +
        "For auto-save footers, call remember before finalizing the reply so you can include the saved @doc ref.\n\n" +
        "• kind=\"fact\" — a single fact or observation. Pass text in `content`.\n" +
        "• kind=\"preference\" — a stable user preference. Pass text in `content`.\n" +
        "• kind=\"document-note\" — DEFAULT for document/file/PDF saves and auto-save notes. " +
        "File ingest accepts only PDF and Word (.docx/.docm); other file types are rejected. " +
        "Pass title + key_points (array of strings, one per product/item/section, up to 10) + summary. " +
        "Do NOT pass `content` — it is ignored. Fast (~50ms). Recall returns the structured note.\n" +
        "• kind=\"document-blob\" — only for 'sf' / 'archive full file' / 'full stash'. " +
        "Requires the complete document text in `content`. Warn the user it will take a moment. " +
        "Use stash_document as a fallback if this times out.\n\n" +
        "One remember call replaces chaining save_memory + stash_document.",
      inputSchema: {
        kind: z
          .enum(["fact", "preference", "document-note", "document-blob"])
          .describe("What type of thing to remember."),
        content: z
          .string()
          .optional()
          .describe("The text to save. Required for fact/preference/document-blob. Omit for document-note."),
        title: z.string().optional().describe("Display title. Used for document-note and document-blob."),
        key_points: z
          .array(z.string())
          .max(10)
          .optional()
          .describe("3–8 bullet points for document-note. Each ~20 words. Omit for other kinds."),
        summary: z
          .string()
          .optional()
          .describe("Short paragraph summary for document-note. Omit for other kinds."),
        source_hint: z
          .string()
          .optional()
          .describe("Human-readable hint about the source, e.g. 'Product catalogue PDF attached this turn'. document-note only."),
        category: z.string().optional().describe("Preference category (preference kind only)."),
        preference_key: z.string().optional().describe("Stable conflict key for preferences, e.g. favorite_color."),
        platform: PlatformSchema.optional().default("claude"),
        openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
        conversation_id: conversationIdSchema,
      },
    },
    async (args) => {
      try {
        const parsed = z.object({
          kind: z.enum(["fact", "preference", "document-note", "document-blob"]),
          content: z.string().optional(),
          title: z.string().optional(),
          key_points: z.array(z.string()).max(10).optional(),
          summary: z.string().optional(),
          source_hint: z.string().optional(),
          category: z.string().optional(),
          preference_key: z.string().optional(),
          platform: PlatformSchema.optional().default("claude"),
          openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
          conversation_id: conversationIdSchema,
        }).parse(normalizeUploadedFileRequestBody(args));

        const result = await executeRememberAction(auth, {
          ...parsed,
          platform: parsed.platform ?? "claude",
          conversation_id: parsed.conversation_id ?? null,
        });
        return toJsonToolResult(result.body, result.status >= 400);
      } catch (err) {
        if (err instanceof DocumentSizeExceededError) {
          return { content: [{ type: "text", text: `⚠️ ${err.message}` }], isError: true };
        }
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "upload_blob",
    {
      title: "Upload Blob",
      description: "Queue uploaded file refs for background ingest. Parity with ChatGPT upload_blob action. Only PDF and Word (.docx/.docm) are supported.",
      inputSchema: {
        openaiFileIdRefs: z.array(openAiFileRefSchema).min(1).max(10),
        conversation_id: conversationIdSchema,
        title: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const parsed = z.object({
          openaiFileIdRefs: z.array(openAiFileRefSchema).min(1).max(10),
          conversation_id: conversationIdSchema,
          title: z.string().optional(),
        }).parse(normalizeUploadedFileRequestBody(args));
        const result = await executeUploadBlobAction(auth, parsed);
        return toJsonToolResult(result.body, result.status >= 400);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "upload_status",
    {
      title: "Upload Status",
      description: "Check status for a queued upload ingest job.",
      inputSchema: {
        ref: z.string().trim().min(1).describe("Upload ingest job ref"),
      },
    },
    async ({ ref }) => {
      try {
        const result = await executeUploadStatusAction(auth, ref);
        return toJsonToolResult(result.body, result.status >= 400);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  server.registerTool(
    "recent_documents",
    {
      title: "Recent Documents",
      description: "Return latest document briefs for this user.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
    },
    async ({ limit }) => {
      try {
        const result = await executeRecentDocumentsAction(auth, limit ?? 5);
        return toJsonToolResult(result.body);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  // One-word undo for auto-saves: user replies "undo" and Claude calls this.
  server.registerTool(
    "undo_save",
    {
      title: "Undo Save",
      description:
        "Deletes a recently auto-saved document or memory by ref. " +
        "Call when the user replies 'undo', 'del', or 'delete' after an auto-save footer. " +
        "Pass the @doc ref from the footer.",
      inputSchema: {
        ref: z.string().min(1).describe("The @doc ref to delete, e.g. @doc:catalogue-a3f2"),
      },
    },
    async ({ ref }) => {
      try {
        const result = await executeUndoSaveAction(auth, ref);
        return toJsonToolResult(result.body);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  // Expose pinned preferences as a passive MCP resource so Claude doesn't need to call recall_memories for stable facts.
  server.registerResource(
    "Pinned Preferences",
    "tallei://preferences/pinned",
    {
      mimeType: "text/markdown",
      description: "User's durable pinned preferences. Read once instead of calling recall_memories for stable facts like identity, defaults, or favourite things.",
    },
    async () => {
      const prefs = await listPreferences(auth);
      const text =
        prefs.length === 0
          ? "_No pinned preferences stored yet._"
          : prefs.map((p) => `- ${p.text}`).join("\n");
      return {
        contents: [{ uri: "tallei://preferences/pinned", mimeType: "text/markdown", text }],
      };
    }
  );
}
