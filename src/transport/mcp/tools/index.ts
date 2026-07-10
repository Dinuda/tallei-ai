import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuthContext } from "../../../domain/auth/index.js";
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
