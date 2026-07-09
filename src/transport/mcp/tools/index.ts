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
  compactCollabTransportPayload,
  CollabConflictError,
  createTask as createCollabTask,
  describeNextActorWork,
  getTask as getCollabTask,
  hydrateTaskWithRecentPreparedUploads,
  inlineDocumentsFromTaskContext,
  listTasks as listCollabTasks,
  submitTurn as submitCollabTurn,
} from "../../../services/collab/collab.service.js";
import { PlatformSchema } from "../schemas.js";
import { mcpToolDefs } from "@tallei/mcp-tools";
import { conversationIdSchema, normalizeUploadedFileRequestBody, openAiFileRefSchema } from "../../http/schemas/uploaded-files.js";
import {
  executePrepareResponseAction,
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
const MemoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note", "checkpoint"]);

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
        text: `⚠️ ${err.message} Ask the user to complete payment, then retry.`,
      }],
      isError: true,
    };
  }
  throw err;
}

function collabPlanRequiredResult(err: PlanRequiredError): ToolResult {
  return toJsonToolResult({
    error: err.message,
    code: "plan_required",
    feature: "collab_sessions",
  }, true);
}

function onKnownError(err: unknown): ToolResult {
  try {
    return onPlanError(err);
  } catch (planErr) {
    return onQuotaError(planErr);
  }
}

function toJsonToolResult(body: unknown, isError = false): ToolResult {
  const safeBody = body && typeof body === "object" && !Array.isArray(body)
    ? compactCollabTransportPayload(body as Record<string, unknown>)
    : body;
  return {
    content: [{ type: "text", text: JSON.stringify(safeBody, null, 2) }],
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

function buildCollabTurnUserVisible(input: {
  content: string;
  taskId: string;
  iteration: number;
  nextWork: string;
  continueCommand: ReturnType<typeof buildFirstTurnContinueCommand>;
}): string {
  return appendContinueCommand([
    input.content,
    "",
    `Saved Claude turn for task ${input.taskId} at iteration ${input.iteration}. Next up: ${input.nextWork}`,
  ].join("\n"), input.continueCommand);
}

function isLikelySummaryOnlyCollabTurn(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (trimmed.length > 1_200) return false;

  const lower = trimmed.toLowerCase();
  const startsLikeSummary = /^(summary|brief summary|high[- ]level summary|overview|highlights?)\b[:\s-]*/i.test(trimmed);
  const hasListMarkers = /(^|\n)\s*(?:[-*]\s+|\d+\.\s+)/.test(trimmed);
  const lineCount = trimmed.split(/\n+/).filter((line) => line.trim().length > 0).length;
  const hasPlaceholderLanguage = /\b(details above|see above|full output|full response)\b/.test(lower);

  return startsLikeSummary && (hasListMarkers || lineCount <= 8 || hasPlaceholderLanguage);
}

function hasCollabWriteScope(auth: AuthContext): boolean {
  if (auth.authMode === "internal" || auth.authMode === "api_key") return true;
  return hasRequiredScopes(auth.scopes ?? [], ["collab:write"]);
}

export function registerTools(server: McpServer, auth: AuthContext): void {
  server.registerTool(
    mcpToolDefs.save_memory.name,
    {
      title: mcpToolDefs.save_memory.title,
      description: mcpToolDefs.save_memory.description,
      inputSchema: mcpToolDefs.save_memory.inputSchema,
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
    mcpToolDefs.save_preference.name,
    {
      title: mcpToolDefs.save_preference.title,
      description: mcpToolDefs.save_preference.description,
      inputSchema: mcpToolDefs.save_preference.inputSchema,
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
    mcpToolDefs.recall_memories.name,
    {
      title: mcpToolDefs.recall_memories.title,
      description: mcpToolDefs.recall_memories.description,
      inputSchema: mcpToolDefs.recall_memories.inputSchema,
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
    mcpToolDefs.collab_check_turn.name,
    {
      title: mcpToolDefs.collab_check_turn.title,
      description: mcpToolDefs.collab_check_turn.description,
      inputSchema: mcpToolDefs.collab_check_turn.inputSchema,
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
        const nextActor = task.state === "CREATIVE"
          ? "chatgpt"
          : task.state === "TECHNICAL"
            ? "claude"
            : null;
        const continueCommand = buildFirstTurnContinueCommand(task);
        const nextWork = describeNextActorWork(task.state, nextActor);
        return toJsonToolResult({
          is_my_turn: Boolean(claimed),
          task_id: task.id,
          title: task.title,
          state: task.state,
          iteration: task.iteration,
          max_iterations: task.maxIterations,
          next_actor: nextActor,
          user_visible: appendContinueCommand(claimed
            ? `It's your turn on task ${task.id} (iteration ${task.iteration + 1}). ${describeNextActorWork(task.state, "claude")} Draft the output, then call collab_take_turn.`
            : nextActor
              ? `Task ${task.id} is waiting on ${nextActor}. Next up: ${nextWork}`
              : `Task ${task.id} has finished all planned iterations. ${nextWork}`, continueCommand),
          continue_command: continueCommand,
          brief: task.brief,
          last_chatgpt_entry: lastChatGptEntry,
          recent_transcript: task.transcript,
          fallback_context: buildTurnFallbackContext(task, "claude"),
          ...(inlineDocuments.length ? { inline_documents: inlineDocuments } : {}),
          ...(uploadSummary ? { upload: uploadSummary } : {}),
        });
      } catch (err) {
        if (err instanceof PlanRequiredError) {
          return collabPlanRequiredResult(err);
        }
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
    mcpToolDefs.collab_take_turn.name,
    {
      title: mcpToolDefs.collab_take_turn.title,
      description: mcpToolDefs.collab_take_turn.description,
      inputSchema: mcpToolDefs.collab_take_turn.inputSchema,
    },
    async ({ task_id, content, openaiFileIdRefs, conversation_id }) => {
      try {
        if (!hasCollabWriteScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["collab:write"] }, true);
        }
        if (isLikelySummaryOnlyCollabTurn(content)) {
          return toJsonToolResult({
            ok: false,
            error: "collab_take_turn requires the full user-facing deliverable content. Summary-only text is not accepted.",
            user_visible: "Submit the complete response content first, then provide summary/handoff text separately in chat.",
          }, true);
        }
        const uploadSummary = openaiFileIdRefs?.length
          ? await attachUploadedFilesToTaskContext(task_id, auth, {
            openaiFileIdRefs,
            conversationId: conversation_id ?? null,
          })
          : null;
        const task = await submitCollabTurn(task_id, "claude", content, auth);
        const nextActor = task.state === "CREATIVE"
          ? "chatgpt"
          : task.state === "TECHNICAL"
            ? "claude"
            : null;
        const savedTurn = task.transcript.length > 0 ? task.transcript[task.transcript.length - 1] : null;
        const continueCommand = buildFirstTurnContinueCommand(task);
        const nextWork = describeNextActorWork(task.state, nextActor);
        return toJsonToolResult({
          ok: true,
          task_id: task.id,
          state: task.state,
          iteration: task.iteration,
          max_iterations: task.maxIterations,
          next_actor: nextActor,
          user_visible: buildCollabTurnUserVisible({
            content,
            taskId: task.id,
            iteration: task.iteration,
            nextWork,
            continueCommand,
          }),
          user_visible_full_output: content,
          user_visible_handoff: appendContinueCommand(`Saved Claude turn for task ${task.id} at iteration ${task.iteration}. Next up: ${nextWork}`, continueCommand),
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
        if (err instanceof PlanRequiredError) {
          return collabPlanRequiredResult(err);
        }
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
              task.state === "CREATIVE"
                ? "chatgpt"
                : task.state === "TECHNICAL"
                  ? "claude"
                  : null
            )
            : null;
          const nextWork = task ? describeNextActorWork(task.state, nextActor) : "";
          return toJsonToolResult({
            ok: false,
            error: err.message,
            task_id,
            state: task?.state ?? null,
            iteration: task?.iteration ?? null,
            max_iterations: task?.maxIterations ?? null,
            next_actor: nextActor,
            user_visible: task
              ? nextActor
                ? `Turn rejected. Task ${task.id} is currently waiting on ${nextActor}. Next up: ${nextWork}`
                : `Turn rejected. Task ${task.id} has finished all planned iterations. ${describeNextActorWork(task.state, null)}`
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
    mcpToolDefs.collab_list_pending.name,
    {
      title: mcpToolDefs.collab_list_pending.title,
      description: mcpToolDefs.collab_list_pending.description,
      inputSchema: mcpToolDefs.collab_list_pending.inputSchema,
    },
    async () => {
      try {
        if (!hasCollabWriteScope(auth)) {
          return toJsonToolResult({ error: "Insufficient OAuth scopes", requiredScopes: ["collab:write"] }, true);
        }
        const tasks = await listCollabTasks({ filter: "waiting" }, auth);
        return toJsonToolResult({ tasks: tasks.filter((task) => task.state === "TECHNICAL") });
      } catch (err) {
        if (err instanceof PlanRequiredError) {
          return collabPlanRequiredResult(err);
        }
        const message = err instanceof Error ? err.message : "Failed to list collab tasks";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    mcpToolDefs.collab_create_task.name,
    {
      title: mcpToolDefs.collab_create_task.title,
      description: mcpToolDefs.collab_create_task.description,
      inputSchema: mcpToolDefs.collab_create_task.inputSchema,
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
        const nextActor = task.state === "CREATIVE"
          ? "chatgpt"
          : task.state === "TECHNICAL"
            ? "claude"
            : null;
        const nextWork = describeNextActorWork(task.state, nextActor);
        return toJsonToolResult({
          ok: true,
          task_id: task.id,
          title: task.title,
          brief: task.brief,
          state: task.state,
          iteration: task.iteration,
          max_iterations: task.maxIterations,
          next_actor: nextActor,
          fallback_context: buildTurnFallbackContext(task, "claude"),
          preflight_recall: preflightRecall.body,
          ...(uploadSummary ? { upload: uploadSummary } : {}),
          user_visible: appendContinueCommand(`Created collab task ${task.id} (${task.title}). Next up: ${nextWork}`, continueCommand),
          continue_command: continueCommand,
        });
      } catch (err) {
        if (err instanceof PlanRequiredError) {
          return collabPlanRequiredResult(err);
        }
        const message = err instanceof Error ? err.message : "Failed to create collab task";
        return toJsonToolResult({ error: message }, true);
      }
    }
  );

  server.registerTool(
    mcpToolDefs.list_preferences.name,
    {
      title: mcpToolDefs.list_preferences.title,
      description: mcpToolDefs.list_preferences.description,
      inputSchema: mcpToolDefs.list_preferences.inputSchema,
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
    mcpToolDefs.forget_preference.name,
    {
      title: mcpToolDefs.forget_preference.title,
      description: mcpToolDefs.forget_preference.description,
      inputSchema: mcpToolDefs.forget_preference.inputSchema,
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
    mcpToolDefs.list_memories.name,
    {
      title: mcpToolDefs.list_memories.title,
      description: mcpToolDefs.list_memories.description,
      inputSchema: mcpToolDefs.list_memories.inputSchema,
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
    mcpToolDefs.delete_memory.name,
    {
      title: mcpToolDefs.delete_memory.title,
      description: mcpToolDefs.delete_memory.description,
      inputSchema: mcpToolDefs.delete_memory.inputSchema,
    },
    async ({ memory_id }) => {
      const result = await deleteMemory(memory_id, auth);
      return { content: [{ type: "text", text: `Deleted memory ${memory_id}. Success: ${result.success}` }] };
    }
  );

  server.registerTool(
    mcpToolDefs.stash_document.name,
    {
      title: mcpToolDefs.stash_document.title,
      description: mcpToolDefs.stash_document.description,
      inputSchema: mcpToolDefs.stash_document.inputSchema,
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
    mcpToolDefs.create_lot.name,
    {
      title: mcpToolDefs.create_lot.title,
      description: mcpToolDefs.create_lot.description,
      inputSchema: mcpToolDefs.create_lot.inputSchema,
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
    mcpToolDefs.recall_document.name,
    {
      title: mcpToolDefs.recall_document.title,
      description: mcpToolDefs.recall_document.description,
      inputSchema: mcpToolDefs.recall_document.inputSchema,
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
    mcpToolDefs.search_documents.name,
    {
      title: mcpToolDefs.search_documents.title,
      description: mcpToolDefs.search_documents.description,
      inputSchema: mcpToolDefs.search_documents.inputSchema,
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
    mcpToolDefs.remember.name,
    {
      title: mcpToolDefs.remember.title,
      description: mcpToolDefs.remember.description,
      inputSchema: mcpToolDefs.remember.inputSchema,
    },
    async (args) => {
      try {
        const parsed = z.object({
          kind: z.enum(["fact", "preference", "document-note", "document-blob", "checkpoint"]),
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
    mcpToolDefs.upload_blob.name,
    {
      title: mcpToolDefs.upload_blob.title,
      description: mcpToolDefs.upload_blob.description,
      inputSchema: mcpToolDefs.upload_blob.inputSchema,
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
    mcpToolDefs.upload_status.name,
    {
      title: mcpToolDefs.upload_status.title,
      description: mcpToolDefs.upload_status.description,
      inputSchema: mcpToolDefs.upload_status.inputSchema,
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
    mcpToolDefs.recent_documents.name,
    {
      title: mcpToolDefs.recent_documents.title,
      description: mcpToolDefs.recent_documents.description,
      inputSchema: mcpToolDefs.recent_documents.inputSchema,
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

  server.registerTool(
    mcpToolDefs.prepare_turn.name,
    {
      title: mcpToolDefs.prepare_turn.title,
      description: mcpToolDefs.prepare_turn.description,
      inputSchema: mcpToolDefs.prepare_turn.inputSchema,
    },
    async (args) => {
      try {
        const parsed = z.object({
          message: z.string().trim().min(1),
          conversation_id: conversationIdSchema,
          conversation_history: z.array(z.object({
            role: z.enum(["user", "assistant", "system", "tool"]).optional(),
            content: z.string().trim().min(1),
          })).max(40).optional(),
          openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional(),
          last_recall: z.object({
            query: z.string().optional(),
            context_hash: z.string().optional(),
          }).optional().nullable(),
        }).parse(normalizeUploadedFileRequestBody(args));

        const result = await executePrepareResponseAction(auth, {
          message: parsed.message,
          conversation_id: parsed.conversation_id ?? null,
          conversation_history: parsed.conversation_history,
          openaiFileIdRefs: parsed.openaiFileIdRefs,
          last_recall: parsed.last_recall ?? null,
        });
        return toJsonToolResult(result.body, result.status >= 400);
      } catch (err) {
        return onKnownError(err);
      }
    }
  );

  // One-word undo for auto-saves: user replies "undo" and Claude calls this.
  server.registerTool(
    mcpToolDefs.undo_save.name,
    {
      title: mcpToolDefs.undo_save.title,
      description: mcpToolDefs.undo_save.description,
      inputSchema: mcpToolDefs.undo_save.inputSchema,
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
