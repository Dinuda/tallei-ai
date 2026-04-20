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
  createLot,
  recallDocument,
  searchDocuments,
  DocumentSizeExceededError,
} from "../../../services/documents.js";
import { PlanRequiredError } from "../../../shared/errors/index.js";
import { PlatformSchema } from "../schemas.js";

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
      description: "Saves a fact, preference, or piece of information to Tallei persistent memory.",
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
      description: "Saves a durable user preference as pinned memory. Use this for identity and stable preferences.",
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
        "If this returns 'No relevant memories found', call list_memories next to scan all stored memories before concluding nothing is saved.",
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
          .describe("Optional @doc/@lot refs to inline full document content alongside memory recall."),
      },
    },
    async ({ query, limit, types, include_doc_refs }) => {
      try {
        const result = await recallMemories(query, auth, limit ?? 5, undefined, { types });
        const refs = [...new Set((include_doc_refs ?? []).map((value) => value.trim()).filter(Boolean))];
        if (refs.length === 0) {
          return { content: [{ type: "text", text: result.contextBlock }] };
        }

        const docBlocks: string[] = [];
        for (const ref of refs) {
          try {
            const recalled = await recallDocument(ref, auth);
            if (recalled.kind === "document") {
              docBlocks.push(
                [
                  `ref: ${recalled.ref}`,
                  `title: ${recalled.title ?? "Untitled"}`,
                  `filename: ${recalled.filename ?? "-"}`,
                  `status: ${recalled.status}`,
                  "",
                  recalled.content,
                ].join("\n")
              );
              continue;
            }

            const lotText = recalled.docs.map((doc) =>
              [
                `ref: ${doc.ref}`,
                `title: ${doc.title ?? "Untitled"}`,
                `filename: ${doc.filename ?? "-"}`,
                `status: ${doc.status}`,
                "",
                doc.content,
              ].join("\n")
            ).join("\n\n====================\n\n");

            docBlocks.push(
              [
                `lot: ${recalled.ref}`,
                `title: ${recalled.title ?? "Untitled lot"}`,
                `count: ${recalled.docs.length}`,
                "",
                lotText,
              ].join("\n")
            );
          } catch (error) {
            if (error instanceof Error && /not found/i.test(error.message)) {
              docBlocks.push(`ref: ${ref}\nerror: ${error.message}`);
              continue;
            }
            throw error;
          }
        }

        if (docBlocks.length === 0) {
          return { content: [{ type: "text", text: result.contextBlock }] };
        }

        const merged = `${result.contextBlock}\n\n---\nInlined Documents\n\n${docBlocks.join("\n\n====================\n\n")}`;
        return { content: [{ type: "text", text: merged }] };
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
      title: "Stash Document",
      description:
        "Stores a full document blob (markdown/text) for later recall. " +
        "Call AFTER finishing your user response. This returns quickly and indexing runs in the background. " +
        "Pro feature: free users receive an upgrade error.",
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
}
