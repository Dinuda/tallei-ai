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

interface JsonRpcError {
  message?: string;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: JsonRpcError;
}

interface ToolContentItem {
  type?: string;
  text?: string;
}

interface ToolCallResult {
  content?: ToolContentItem[];
  isError?: boolean;
}

function parseSseJsonRpc(body: string): JsonRpcEnvelope {
  const events: string[] = [];
  const lines = body.split(/\r?\n/);
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      currentData.push(line.slice(5).trimStart());
      continue;
    }
    if (line.trim() === "") {
      if (currentData.length > 0) {
        events.push(currentData.join("\n"));
        currentData = [];
      }
    }
  }
  if (currentData.length > 0) {
    events.push(currentData.join("\n"));
  }

  for (const data of events) {
    if (!data || !data.trim()) continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcEnvelope;
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON events and keep scanning for JSON-RPC payload.
    }
  }

  throw new Error(
    `MCP response was SSE but no JSON-RPC payload was found. First bytes: ${body.slice(0, 120)}`
  );
}

async function mcpCall(userId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer eval:${userId}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    if (res.status === 401) {
      throw new Error(
        `MCP HTTP 401: ${text}\n` +
        `  → Eval auth failed for userId=${userId}.\n` +
        `  → Ensure server is running with EVAL_MODE=true (non-production) and EVAL_USER_ID is a real user UUID in your DB.`
      );
    }
    throw new Error(`MCP HTTP ${res.status}: ${text}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const json = contentType.includes("text/event-stream")
    ? parseSseJsonRpc(await res.text())
    : JSON.parse(await res.text()) as JsonRpcEnvelope;

  if (json.error) throw new Error(`MCP error: ${json.error.message}`);
  return json.result;
}

function toolMessage(result: ToolCallResult): string {
  const text = result?.content?.[0]?.text;
  if (typeof text === "string" && text.trim().length > 0) return text;
  return "Unknown tool response";
}

function parseToolCallResult(result: unknown): ToolCallResult {
  if (!result || typeof result !== "object") {
    throw new Error(`Unexpected MCP tool result shape: ${String(result)}`);
  }
  return result as ToolCallResult;
}

export async function saveMemory(content: string, userId: string): Promise<void> {
  const rawResult = await mcpCall(userId, "tools/call", {
    name: "save_memory",
    arguments: { content, platform: "other" },
  });
  const result = parseToolCallResult(rawResult);
  const message = toolMessage(result);
  if (result.isError || message.startsWith("⚠️")) {
    throw new Error(`save_memory failed: ${message}`);
  }
}

export async function recallMemories(
  query: string,
  userId: string,
  limit = 10
): Promise<string> {
  const rawResult = await mcpCall(userId, "tools/call", {
    name: "recall_memories",
    arguments: { query, limit },
  });
  const result = parseToolCallResult(rawResult);
  const message = toolMessage(result);
  if (result.isError || message.startsWith("⚠️")) {
    throw new Error(`recall_memories failed: ${message}`);
  }
  return message || "--- No relevant memories found ---";
}

export async function listMemoriesText(userId: string): Promise<string> {
  const rawResult = await mcpCall(userId, "tools/call", {
    name: "list_memories",
    arguments: {},
  });
  const result = parseToolCallResult(rawResult);
  const message = toolMessage(result);
  if (result.isError || message.startsWith("⚠️")) {
    throw new Error(`list_memories failed: ${message}`);
  }
  return message;
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

export function getEvalUserIdOrThrow(): string {
  const userId = process.env["EVAL_USER_ID"]?.trim();
  if (!userId) {
    throw new Error(
      "Missing EVAL_USER_ID. Set it to an existing user UUID before running evals."
    );
  }
  return userId;
}

export async function assertEvalAuthOrThrow(userId: string): Promise<void> {
  await recallMemories("__tallei_eval_auth_check__", userId, 1);
}

export { BASE_URL };
