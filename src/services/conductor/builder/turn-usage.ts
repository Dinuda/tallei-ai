import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import type { LoopBuilderUsage } from "../utils/progress.js";
import { emptyLoopBuilderUsage, mergeLoopBuilderUsageTotals } from "../utils/progress.js";

export async function loadSessionCommandUsage(auth: AuthContext, sessionId: string): Promise<LoopBuilderUsage> {
  const result = await pool.query<{ usage_json: LoopBuilderUsage | null }>(
    `SELECT usage_json
     FROM workflow_builder_commands
     WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3`,
    [sessionId, auth.tenantId, auth.userId],
  );
  return mergeLoopBuilderUsageTotals(
    emptyLoopBuilderUsage(),
    ...result.rows.map((row) => row.usage_json ?? emptyLoopBuilderUsage()),
  );
}
