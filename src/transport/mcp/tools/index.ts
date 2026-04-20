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
  explainMemoryConnection,
  listMemoryEntities,
  recallMemoriesV2,
} from "../../../orchestration/graph/recall-v2.usecase.js";
import { getMemoryGraphInsights } from "../../../orchestration/graph/graph-insights.usecase.js";
import { PlatformSchema } from "../schemas.js";

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };
const MemoryTypeSchema = z.enum(["preference", "fact", "event", "decision", "note"]);

function onQuotaError(err: unknown): ToolResult {
  if (err instanceof QuotaExceededError) {
    return { content: [{ type: "text", text: `⚠️ ${err.message}` }], isError: true };
  }
  throw err;
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
        return onQuotaError(err);
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
        return onQuotaError(err);
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
      },
    },
    async ({ query, limit, types }) => {
      try {
        const result = await recallMemories(query, auth, limit ?? 5, undefined, { types });
        return { content: [{ type: "text", text: result.contextBlock }] };
      } catch (err) {
        return onQuotaError(err);
      }
    }
  );

  server.registerTool(
    "recall_memories_v2",
    {
      title: "Recall Memories v2",
      description: "Graph-enhanced recall with compact reasoning paths.",
      inputSchema: {
        query: z.string().describe("What to search for."),
        limit: z.number().int().min(1).max(20).optional().default(5),
        graph_depth: z.number().int().min(1).max(2).optional().default(1),
      },
    },
    async ({ query, limit, graph_depth }) => {
      if (!config.recallV2Enabled) {
        return { content: [{ type: "text", text: "recall_memories_v2 is disabled." }] };
      }
      const result = await recallMemoriesV2(query, auth, limit ?? 5, graph_depth ?? 1);
      return { content: [{ type: "text", text: result.contextBlock }] };
    }
  );

  server.registerTool(
    "list_memory_entities",
    {
      title: "List Memory Entities",
      description: "Lists graph entities extracted from user memories.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(30),
        query: z.string().optional(),
      },
    },
    async ({ limit, query }) => {
      const entities = await listMemoryEntities(auth, limit ?? 30, query);
      if (entities.length === 0) {
        return { content: [{ type: "text", text: "No memory entities found yet." }] };
      }
      const text = entities
        .map((e) => `• ${e.label} [${e.entityType}] conf=${e.confidence.toFixed(2)}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "explain_memory_connection",
    {
      title: "Explain Memory Connection",
      description: "Finds the graph connection path between two entity queries.",
      inputSchema: {
        source: z.string().describe("Source entity query"),
        target: z.string().describe("Target entity query"),
      },
    },
    async ({ source, target }) => {
      const result = await explainMemoryConnection(auth, source, target);
      const text = result.found
        ? `${result.explanation}\nPath: ${result.path.join(" -> ")}`
        : result.explanation;
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "memory_graph_insights",
    {
      title: "Memory Graph Insights",
      description: "Returns contradictions, stale decisions, and high-impact relationships.",
      inputSchema: {},
    },
    async () => {
      if (!config.graphExtractionEnabled) {
        return { content: [{ type: "text", text: "memory_graph_insights is disabled." }] };
      }
      const insights = await getMemoryGraphInsights(auth);
      const lines = [
        `Generated: ${insights.generatedAt}`,
        `Contradictions: ${insights.summary.contradictionCount}`,
        `Stale decisions: ${insights.summary.staleDecisionCount}`,
        `High-impact relations: ${insights.summary.highImpactCount}`,
        "",
        ...insights.recommendations.slice(0, 4).map((r) => `• ${r}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
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
}
