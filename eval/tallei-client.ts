/**
 * Thin HTTP client for the Tallei MCP endpoint.
 * Requires EVAL_MODE=true on the server and a userId that exists in the DB.
 *
 * Usage:
 *   TALLEI_EVAL_URL=http://localhost:3000/mcp
 *   EVAL_USER_ID=<uuid>
 */

const BASE_URL = process.env["TALLEI_EVAL_URL"] ?? "http://localhost:3000/mcp";

let _reqId = 0;
function nextId() { return ++_reqId; }

async function mcpCall(userId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer eval:${userId}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`MCP HTTP ${res.status}: ${text}`);
  }

  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`MCP error: ${json.error.message}`);
  return json.result;
}

export async function saveMemory(content: string, userId: string): Promise<void> {
  await mcpCall(userId, "tools/call", {
    name: "save_memory",
    arguments: { content, platform: "other" },
  });
}

export async function recallMemories(
  query: string,
  userId: string,
  limit = 10
): Promise<string> {
  const result = await mcpCall(userId, "tools/call", {
    name: "recall_memories",
    arguments: { query, limit },
  }) as { content?: Array<{ type: string; text: string }> };

  return result?.content?.[0]?.text ?? "--- No relevant memories found ---";
}

export async function deleteAllMemories(userId: string): Promise<void> {
  const listResult = await mcpCall(userId, "tools/call", {
    name: "list_memories",
    arguments: {},
  }) as { content?: Array<{ type: string; text: string }> };

  const text = listResult?.content?.[0]?.text ?? "";
  // Parse memory IDs from bullet list: "• <text>" — we need another approach
  // list_memories returns bullet text, not IDs. We skip cleanup between benchmark users
  // by using unique user IDs per benchmark run instead.
  void text; // intentionally unused
}

export { BASE_URL };
