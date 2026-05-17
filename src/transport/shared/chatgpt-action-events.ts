import type { AuthContext } from "../../domain/auth/index.js";
import { config } from "../../config/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { setRequestTimingField } from "../../observability/request-timing.js";
import { runAsyncSafe } from "../../shared/async-safe.js";

type EventMetadata = Record<string, unknown>;

export type ChatGptActionMethod =
  | "chatgpt/actions/recall_memories"
  | "chatgpt/actions/prepare_response"
  | "chatgpt/actions/remember"
  | "chatgpt/actions/upload_blob"
  | "chatgpt/actions/upload_status"
  | "chatgpt/actions/undo_save"
  | "chatgpt/actions/recent_documents"
  | "chatgpt/actions/search_documents"
  | "chatgpt/actions/recall_document"
  | "chatgpt/collab/create-task"
  | "chatgpt/collab/run-turn"
  | "chatgpt/collab/submit-turn"
  | "chatgpt/collab/continue"
  | "chatgpt/collab/tasks"
  | "chatgpt/actions/orchestrate_start"
  | "chatgpt/actions/orchestrate_answer"
  | "chatgpt/actions/orchestrate_approve"
  | "chatgpt/actions/orchestrate_abort";

export async function logChatGptAction(input: {
  auth: AuthContext | null | undefined;
  method: ChatGptActionMethod;
  collabTaskId?: string | null;
  metadata?: EventMetadata | null;
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  const auth = input.auth;
  if (!auth) return;

  try {
    await pool.query(
      `INSERT INTO mcp_call_events (
        tenant_id, user_id, key_id, auth_mode, method, tool_name, collab_task_id, metadata_json, ok, error
      )
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::jsonb, $8, $9)`,
      [
        auth.tenantId,
        auth.userId,
        auth.keyId ?? null,
        auth.authMode,
        input.method,
        input.collabTaskId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ok,
        input.error ?? null,
      ]
    );
  } catch (error) {
    if (config.nodeEnv !== "production") {
      console.error("[chatgpt] failed to persist action event:", error);
    }
  }
}

export function logChatGptActionAsync(input: Parameters<typeof logChatGptAction>[0]): void {
  setRequestTimingField("event_log_mode", "async");
  runAsyncSafe(() => logChatGptAction(input), "chatgpt action event");
}
