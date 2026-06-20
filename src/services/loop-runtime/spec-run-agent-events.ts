import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";

export async function emitRunEvent(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO loop_engine_events (tenant_id, user_id, run_id, step_attempt_id, event_type, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.auth.tenantId,
      input.auth.userId,
      input.runId,
      input.stepAttemptId ?? null,
      input.eventType,
      JSON.stringify(input.payload),
    ],
  );
}
