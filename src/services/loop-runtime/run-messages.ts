import type { UIMessage } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";

export function mergeRunChatMessages(server: UIMessage[], client: UIMessage[]): UIMessage[] {
  const serverIds = new Set(server.map((message) => message.id));
  const trailingClient = client.filter((message) => !serverIds.has(message.id));
  return normalizeRunMessages([...server, ...trailingClient]);
}

function getAgentStepIndex(part: unknown): number | undefined {
  if (typeof part !== "object" || !part) return undefined;
  const p = part as Record<string, unknown>;
  if (p.type !== "data-agent") return undefined;
  const data = p.data;
  if (typeof data !== "object" || !data) return undefined;
  const stepIndex = (data as Record<string, unknown>).stepIndex;
  return typeof stepIndex === "number" ? stepIndex : undefined;
}

// When a stream resumes after an interaction approval the new stream may re-emit
// agent headers for the same step index that already exist in the stored messages.
// Keep only the LAST message for each step index so the DB stays clean.
function dedupeAgentMessagesByStepIndex(messages: UIMessage[]): UIMessage[] {
  const stepIndexLastPos = new Map<number, number>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    for (const part of message.parts) {
      const stepIndex = getAgentStepIndex(part);
      if (stepIndex !== undefined) stepIndexLastPos.set(stepIndex, index);
    }
  });
  return messages.filter((message, index) => {
    if (message.role !== "assistant") return true;
    for (const part of message.parts) {
      const stepIndex = getAgentStepIndex(part);
      if (stepIndex !== undefined) return stepIndexLastPos.get(stepIndex) === index;
    }
    return true;
  });
}

export function normalizeRunMessages(messages: unknown[]): UIMessage[] {
  const normalized = messages.filter((message): message is UIMessage =>
    Boolean(message && typeof message === "object" && "role" in message && "parts" in message));

  const seen = new Set<string>();
  const deduped = normalized
    .filter((message) => Array.isArray(message.parts) && message.parts.length > 0)
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  return dedupeAgentMessagesByStepIndex(deduped);
}

export async function listLoopRunMessages(auth: AuthContext, runId: string): Promise<UIMessage[]> {
  const result = await pool.query<{ message_json: unknown }>(
    `SELECT message_json
     FROM loop_run_messages
     WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3
     ORDER BY sequence ASC`,
    [runId, auth.tenantId, auth.userId],
  );
  return normalizeRunMessages(result.rows.map((row) => row.message_json));
}

export async function replaceLoopRunMessages(auth: AuthContext, runId: string, messages: UIMessage[]): Promise<void> {
  const normalizedMessages = normalizeRunMessages(messages);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM loop_run_messages WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3`,
      [runId, auth.tenantId, auth.userId],
    );
    for (const message of normalizedMessages) {
      await client.query(
        `INSERT INTO loop_run_messages (run_id, tenant_id, user_id, message_json)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [runId, auth.tenantId, auth.userId, JSON.stringify(message)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
