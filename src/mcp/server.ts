import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import { z } from "zod";
import { saveMemory, recallMemories, listMemories, deleteMemory } from "../services/memory.js";
import { validateApiKey } from "../services/auth.js";

function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: "tallei",
    version: "1.0.0",
  });

  // Tool: save_memory
  server.registerTool(
    "save_memory",
    {
      title: "Save Memory",
      description: "Saves a conversation or piece of information as a persistent memory in Tallei.",
      inputSchema: {
        content: z.string().describe("The conversation content or information to remember"),
        platform: z.enum(["claude", "chatgpt", "gemini", "other"]).optional().default("claude").describe("The AI platform this memory is from"),
      },
    },
    async ({ content, platform }) => {
      const result = await saveMemory(content, userId, platform ?? "claude");
      return {
        content: [{
          type: "text",
          text: `✅ Memory saved!\nTitle: ${result.title}\nKey Points: ${result.summary.keyPoints.join(", ")}`,
        }],
      };
    }
  );

  // Tool: recall_memories
  server.registerTool(
    "recall_memories",
    {
      title: "Recall Memories",
      description: "Searches your past memories in Tallei and returns relevant context. Call this automatically at the start of every conversation.",
      inputSchema: {
        query: z.string().describe("What you want to recall about. E.g., 'user preferences', 'project goals', 'what is tallei'"),
        limit: z.number().int().min(1).max(20).optional().default(5),
      },
    },
    async ({ query, limit }) => {
      const result = await recallMemories(query, userId, limit ?? 5);
      return {
        content: [{
          type: "text",
          text: result.contextBlock,
        }],
      };
    }
  );

  // Tool: list_memories
  server.registerTool(
    "list_memories",
    {
      title: "List Memories",
      description: "Lists all recent memories stored in Tallei for this user.",
      inputSchema: {},
    },
    async () => {
      const memories = await listMemories(userId);
      if (memories.length === 0) {
        return { content: [{ type: "text", text: "No memories stored yet." }] };
      }
      const text = memories.map((m: any) => `• ${m.text}`).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // Tool: delete_memory
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
      const result = await deleteMemory(memory_id);
      return {
        content: [{ type: "text", text: `Deleted memory ${memory_id}. Success: ${result.success}` }],
      };
    }
  );

  return server;
}

export function createMcpRouter(): Router {
  const router = Router();

  const handleMcp = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.split(" ")[1];
    let userId: string | null = null;

    if (token.startsWith("gm_")) {
      userId = await validateApiKey(token);
    }

    if (!userId) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }

    const server = buildMcpServer(userId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  // Express 5: use "/" for root, "/{*path}" for sub-paths
  router.all("/", handleMcp);
  router.all("/{*path}", handleMcp);

  return router;
}
