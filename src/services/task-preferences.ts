import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";

export interface TaskPreferences {
  grillMeEnabled: boolean;
  grillMeRecommended: boolean;
  grillMeRecommendationReason: string | null;
  correctionSignalCount: number;
}

export async function getTaskPreferences(auth: AuthContext): Promise<TaskPreferences> {
  const result = await pool.query<{ grill_me_enabled: boolean }>(
    `SELECT grill_me_enabled
     FROM user_task_preferences
     WHERE user_id = $1
       AND tenant_id = $2
     LIMIT 1`,
    [auth.userId, auth.tenantId]
  );
  const row = result.rows[0];
  const grillMeEnabled = row?.grill_me_enabled ?? false;

  const sessions = await pool.query<{ transcript: unknown }>(
    `SELECT transcript
     FROM orchestration_sessions
     WHERE user_id = $1
       AND tenant_id = $2
       AND status IN ('PLAN_READY', 'RUNNING', 'DONE', 'ABORTED')
     ORDER BY updated_at DESC
     LIMIT 12`,
    [auth.userId, auth.tenantId]
  );

  const correctionPattern =
    /\b(actually|instead|not quite|that'?s wrong|wrong|fix|change|revise|update|correction|i meant|no[, ]|doesn'?t)\b/i;
  let correctionSignalCount = 0;

  for (const session of sessions.rows) {
    if (!Array.isArray(session.transcript)) continue;
    for (const entry of session.transcript) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record["role"] !== "user") continue;
      const content = typeof record["content"] === "string" ? record["content"] : "";
      if (correctionPattern.test(content)) {
        correctionSignalCount += 1;
      }
    }
  }

  const grillMeRecommended = correctionSignalCount >= 3;
  return {
    grillMeEnabled,
    grillMeRecommended,
    grillMeRecommendationReason: grillMeRecommended
      ? "Recent planning replies included repeated corrections. Grill-me can reduce rework."
      : null,
    correctionSignalCount,
  };
}

export async function setTaskPreferences(
  auth: AuthContext,
  input: Partial<TaskPreferences>
): Promise<TaskPreferences> {
  const next = {
    grillMeEnabled: input.grillMeEnabled ?? false,
  };

  await pool.query(
    `INSERT INTO user_task_preferences (tenant_id, user_id, grill_me_enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id)
     DO UPDATE SET
       grill_me_enabled = EXCLUDED.grill_me_enabled,
       updated_at = now()`,
    [auth.tenantId, auth.userId, next.grillMeEnabled]
  );

  return getTaskPreferences(auth);
}
