import type { UIMessage } from "ai";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";

export function normalizeRunMessages(messages: unknown[]): UIMessage[] {
  return messages.filter((message): message is UIMessage =>
    Boolean(message && typeof message === "object" && "role" in message && "parts" in message));
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM loop_run_messages WHERE run_id = $1 AND tenant_id = $2 AND user_id = $3`,
      [runId, auth.tenantId, auth.userId],
    );
    for (const message of messages) {
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
