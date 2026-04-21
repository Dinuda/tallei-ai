import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { config } from "../../../config/index.js";
import type { AuthContext } from "../../../domain/auth/index.js";
import {
  saveMemory,
  savePreference,
  recallMemories,
  listMemories,
  listPreferences,
  forgetPreference,
  deleteMemory,
  QuotaExceededError,
} from "../../../services/memory.js";
import {
  stashDocument,
  stashDocumentNote,
  createLot,
  recallDocument,
  searchDocuments,
  deleteDocumentByRef,
  DocumentSizeExceededError,
  recentDocumentBriefs,
  documentBriefsByRefs,
  type DocumentBrief,
  type DocumentRefBrief,
} from "../../../services/documents.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { PlatformSchema } from "../schemas.js";

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };
const MemoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note"]);

function formatDocumentBriefLine(doc: DocumentBrief): string {
  const parts = [`• ${doc.ref}`, doc.title];
  if (doc.preview) parts.push(doc.preview);
  return parts.join(" | ");
}

function formatReferencedBriefLine(item: DocumentRefBrief): string {
  if (item.kind === "document") {
    return formatDocumentBriefLine(item);
  }
  if (item.kind === "lot") {
    const docSummary = item.documents.map((doc) => doc.title).join(", ");
    const suffix = docSummary ? ` | docs: ${docSummary}` : "";
    return `• ${item.ref} | ${item.title} | count=${item.documentCount}${suffix}`;
  }
  return `• ${item.ref} | ${item.error}`;
}

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
        text: `⚠️ PDF stash is a Pro feature. Upgrade at ${config.dashboardBaseUrl.replace(/\/$/, "")}/billing.`,
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
          .describe("Optional @doc/@lot refs to append brief document metadata (no full content)."),
      },
    },
    async ({ query, limit, types, include_doc_refs }) => {
      try {
        const scopedTypes: Array<z.infer<typeof MemoryTypeSchema>> =
          types && types.length > 0 ? types : ["fact", "preference"];
        const result = await recallMemories(query, auth, limit ?? 5, undefined, { types: scopedTypes });
        const sections: string[] = [result.contextBlock];

        const recentDocs = await recentDocumentBriefs(auth, 5);
        if (recentDocs.length > 0) {
          sections.push(`Recent Documents (latest 5)\n${recentDocs.map(formatDocumentBriefLine).join("\n")}`);
        }

        const refs = [...new Set((include_doc_refs ?? []).map((value) => value.trim()).filter(Boolean))];
        if (refs.length > 0) {
          const referenced = await documentBriefsByRefs(refs, auth, { maxLotDocs: 5 });
          if (referenced.length > 0) {
            sections.push(`Referenced Documents (brief)\n${referenced.map(formatReferencedBriefLine).join("\n")}`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n\n---\n") }] };
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
        const recalled = await recallDocument(ref, auth);

        if (recalled.kind === "lot") {
          const lotText = recalled.docs
            .map((doc) => {
              const header = [
                `ref: ${doc.ref}`,
                `title: ${doc.title ?? "Untitled"}`,
                `filename: ${doc.filename ?? "-"}`,
                `status: ${doc.status}`,
              ].join("\n");
              return `${header}\n\n${doc.content}`;
            })
            .join("\n\n====================\n\n");

          return {
            content: [{
              type: "text",
              text: `lot: ${recalled.ref}\ntitle: ${recalled.title ?? "Untitled lot"}\ncount: ${recalled.docs.length}\n\n${lotText}`,
            }],
          };
        }

        const header = [
          `ref: ${recalled.ref}`,
          `title: ${recalled.title ?? "Untitled"}`,
          `filename: ${recalled.filename ?? "-"}`,
          `status: ${recalled.status}`,
        ].join("\n");

        return { content: [{ type: "text", text: `${header}\n\n${recalled.content}` }] };
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
        const hits = await searchDocuments(query, auth, limit ?? 5);
        if (hits.length === 0) {
          return { content: [{ type: "text", text: "No matching documents found." }] };
        }
        const text = hits
          .map((hit) => {
            const preview = hit.preview ? ` — ${hit.preview.slice(0, 140)}` : "";
            return `• ${hit.ref} | ${hit.title} | score=${hit.score.toFixed(3)}${preview}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }] };
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
      },
    },
    async ({ kind, content, title, key_points, summary, source_hint, category, preference_key, platform }) => {
      try {
        if (kind === "fact") {
          if (!content) return { content: [{ type: "text", text: "⚠️ content is required for kind=fact" }], isError: true };
          const saved = await saveMemory(content, auth, platform ?? "claude");
          return { content: [{ type: "text", text: `✅ Fact saved (${saved.memoryId}).` }] };
        }

        if (kind === "preference") {
          if (!content) return { content: [{ type: "text", text: "⚠️ content is required for kind=preference" }], isError: true };
          const saved = await savePreference(content, auth, platform ?? "claude", undefined, {
            category: category ?? null,
            preferenceKey: preference_key ?? null,
          });
          return { content: [{ type: "text", text: `✅ Preference saved (${saved.memoryId}).` }] };
        }

        if (kind === "document-note") {
          const noteTitle = title ?? "Untitled Note";
          const stashed = await stashDocumentNote({
            title: noteTitle,
            key_points: key_points ?? [],
            summary: summary ?? "",
            source_hint: source_hint ?? "",
          }, auth);
          return { content: [{ type: "text", text: `✅ Document note saved as ${stashed.refHandle}.` }] };
        }

        // document-blob
        if (!content) return { content: [{ type: "text", text: "⚠️ content is required for kind=document-blob" }], isError: true };
        const stashed = await stashDocument(content, auth, { title: title ?? undefined });
        const lotSuffix = stashed.lotRef ? ` Auto-lot: ${stashed.lotRef}.` : "";
        return { content: [{ type: "text", text: `✅ Document archived as ${stashed.refHandle}.${lotSuffix}` }] };
      } catch (err) {
        if (err instanceof DocumentSizeExceededError) {
          return { content: [{ type: "text", text: `⚠️ ${err.message}` }], isError: true };
        }
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
        const result = await deleteDocumentByRef(ref, auth);
        return { content: [{ type: "text", text: result.success ? `🗑️ Deleted ${ref}.` : `⚠️ Could not delete ${ref}.` }] };
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
