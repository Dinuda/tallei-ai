import { z } from "zod";

export const PlatformSchema = z.enum(["claude", "chatgpt", "gemini", "other"]);
export const MemoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note", "checkpoint"]);

export const conversationIdSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(200).optional(),
);

export const openAiFileRefSchema = z.object({
  id: z.string().min(1, "file id is required"),
  name: z.string().optional(),
  mime_type: z.string().nullable().optional(),
  download_link: z.string()
    .url("download_link must be a valid URL")
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
      } catch {
        return false;
      }
    }, "download_link must be an http(s) URL from GPT Actions (not file:// or local paths)"),
});

export type McpToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
};

export const mcpToolDefs = {
  save_memory: {
    name: "save_memory" as const,
    title: "Save Memory",
    description: "Prefer the `remember` tool — it handles facts, preferences, and document notes in one call. This tool exists for backward compatibility.",
    inputSchema: {
        content: z
          .string()
          .describe("The fact, preference, or information to remember. Be specific and concise."),
        platform: PlatformSchema.optional().default("claude").describe("The AI platform this memory is from"),
      },
  },
  save_preference: {
    name: "save_preference" as const,
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
  recall_memories: {
    name: "recall_memories" as const,
    title: "Recall Memories",
    description: "Searches Tallei persistent memory and returns relevant past context. " +
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
  list_preferences: {
    name: "list_preferences" as const,
    title: "List Preferences",
    description: "Lists pinned and active user preferences.",
    inputSchema: {},
  },
  forget_preference: {
    name: "forget_preference" as const,
    title: "Forget Preference",
    description: "Deletes a preference memory by ID.",
    inputSchema: {
        preference_id: z.string().describe("Preference memory ID"),
      },
  },
  list_memories: {
    name: "list_memories" as const,
    title: "List Memories",
    description: "Lists all recent memories stored in Tallei for this user.",
    inputSchema: {},
  },
  delete_memory: {
    name: "delete_memory" as const,
    title: "Delete Memory",
    description: "Deletes a specific memory from Tallei by its ID.",
    inputSchema: {
        memory_id: z.string().describe("The unique ID of the memory to delete"),
      },
  },
  stash_document: {
    name: "stash_document" as const,
    title: "Stash Document Full Blob",
    description: "HEAVY: Requires emitting the entire document as the `content` argument. " +
        "Prefer remember(kind=\"document-note\") for most 'save this document' requests — it needs no content field. " +
        "Only use this when the user explicitly says to archive or store the full file for future retrieval. " +
        "Call AFTER finishing your user response. Indexing runs in the background.",
    inputSchema: {
        content: z.string().min(1).describe("Full document markdown/text to store verbatim."),
        filename: z.string().optional().describe("Optional source filename."),
        title: z.string().optional().describe("Optional display title."),
      },
  },
  create_lot: {
    name: "create_lot" as const,
    title: "Create Lot",
    description: "Groups existing stashed documents under one @lot handle for multi-file recall.",
    inputSchema: {
        refs: z.array(z.string()).min(1).describe("Array of @doc:... references to group."),
        title: z.string().optional().describe("Optional lot title."),
      },
  },
  recall_document: {
    name: "recall_document" as const,
    title: "Recall Document",
    description: "Returns the complete stored document markdown for an @doc ref, or all full docs for an @lot ref. " +
        "May be large: use only when the user clearly needs the full file.",
    inputSchema: {
        ref: z.string().min(1).describe("Document or lot reference, e.g. @doc:... or @lot:..."),
      },
  },
  search_documents: {
    name: "search_documents" as const,
    title: "Search Documents",
    description: "Vector-searches stashed document summaries and returns matching refs for discovery. " +
        "Does not return full content.",
    inputSchema: {
        query: z.string().min(1).describe("Search query to find relevant documents."),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
  },
  remember: {
    name: "remember" as const,
    title: "Save / Stash to Memory (remember)",
    description: "Save a memory, save a preference, or stash a document to Tallei persistent memory. " +
        "Use this for explicit save requests AND required auto-save of newly processed structured content. " +
        "For auto-save footers, call remember before finalizing the reply so you can include the saved @doc ref.\n\n" +
        "• kind=\"fact\" — a single fact or observation. Pass text in `content`.\n" +
        "• kind=\"preference\" — a stable user preference. Pass text in `content`.\n" +
        "• kind=\"document-note\" — DEFAULT for document/file/PDF saves and auto-save notes. " +
        "File ingest accepts only PDF and Word (.docx/.docm); other file types are rejected. " +
        "Pass title + key_points (array of strings, one per product/item/section, up to 10) + summary. " +
        "If generated or pasted content should be preserved, pass the full text in `content`; it will be saved as a real @doc document.\n" +
        "• kind=\"document-blob\" — only for 'sf' / 'archive full file' / 'full stash'. " +
        "Requires the complete document text in `content`. Warn the user it will take a moment. " +
        "Use stash_document as a fallback if this times out.\n\n" +
        "One remember call replaces chaining save_memory + stash_document.",
    inputSchema: {
        kind: z
          .enum(["fact", "preference", "document-note", "document-blob", "checkpoint"])
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
  upload_blob: {
    name: "upload_blob" as const,
    title: "Upload Blob",
    description: "Queue uploaded file refs for background ingest. Parity with ChatGPT upload_blob action. Only PDF and Word (.docx/.docm) are supported.",
    inputSchema: {
        openaiFileIdRefs: z.array(openAiFileRefSchema).min(1).max(10),
        conversation_id: conversationIdSchema,
        title: z.string().optional(),
      },
  },
  upload_status: {
    name: "upload_status" as const,
    title: "Upload Status",
    description: "Check status for a queued upload ingest job.",
    inputSchema: {
        ref: z.string().trim().min(1).describe("Upload ingest job ref"),
      },
  },
  recent_documents: {
    name: "recent_documents" as const,
    title: "Recent Documents",
    description: "Return latest document briefs for this user.",
    inputSchema: {
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
  },
  prepare_turn: {
    name: "prepare_turn" as const,
    title: "Prepare Turn",
    description: "PRIMARY ENTRY POINT. Call this FIRST on every turn. " +
        "Equivalent to ChatGPT's prepare_response. It classifies intent, recalls memories, " +
        "auto-saves files, queues checkpoint saves, and returns replyInstructions telling you what to do next. " +
        "Always call this before any other tool on a new turn.",
    inputSchema: {
        message: z.string().trim().min(1).describe("Exact current user message."),
        conversation_id: conversationIdSchema,
        conversation_history: z.array(z.object({
          role: z.enum(["user", "assistant", "system", "tool"]).optional(),
          content: z.string().trim().min(1),
        })).max(40).optional().describe("Visible conversation history for checkpoint auto-save."),
        openaiFileIdRefs: z.array(openAiFileRefSchema).max(10).optional().describe("Attached files with temporary HTTPS download_link URLs."),
        last_recall: z.object({
          query: z.string().optional(),
          context_hash: z.string().optional(),
        }).optional().nullable().describe("Previous recall state for deduplication."),
      },
  },
  undo_save: {
    name: "undo_save" as const,
    title: "Undo Save",
    description: "Deletes a recently auto-saved document or memory by ref. " +
        "Call when the user replies 'undo', 'del', or 'delete' after an auto-save footer. " +
        "Pass the @doc ref from the footer.",
    inputSchema: {
        ref: z.string().min(1).describe("The @doc ref to delete, e.g. @doc:catalogue-a3f2"),
      },
  },
} as const;

export type McpToolName = keyof typeof mcpToolDefs;
export const MCP_TOOL_NAMES = Object.keys(mcpToolDefs) as McpToolName[];
