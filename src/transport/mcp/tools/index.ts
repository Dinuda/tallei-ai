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
      description: "Queue uploaded file refs for background ingest. Parity with ChatGPT upload_blob action.",
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
