import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";

export interface TaskPreferences {
  grillMeEnabled: boolean;
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
  return { grillMeEnabled: row?.grill_me_enabled ?? false };
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

  return next;
}

