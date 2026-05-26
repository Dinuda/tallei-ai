import { randomUUID } from "node:crypto";

import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";

export interface DailyIntelligenceRunClaimed {
  claimed: true;
  runId: string;
}

export interface DailyIntelligenceRunSkipped {
  claimed: false;
  reason: "already_processed_today";
  existingRunId: string | null;
}

export async function claimDailyIntelligenceRun(auth: AuthContext): Promise<DailyIntelligenceRunClaimed | DailyIntelligenceRunSkipped> {
  const runId = randomUUID();
  const lockKey = `${auth.tenantId}:${auth.userId}:daily-intelligence:utc`;
  const claim = await pool.query<{ inserted_id: string | null; existing_id: string | null }>(
    `WITH lock_key AS (
       SELECT pg_advisory_xact_lock(hashtext($4))
     ),
     existing AS (
       SELECT id
       FROM daily_intelligence_runs
       WHERE tenant_id = $1
         AND user_id = $2
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ORDER BY created_at DESC
       LIMIT 1
     ),
     inserted AS (
       INSERT INTO daily_intelligence_runs
         (id, tenant_id, user_id, status, metadata_json)
       SELECT
         $3,
         $1,
         $2,
         'running',
         $5::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     )
     SELECT
       (SELECT id FROM inserted LIMIT 1) AS inserted_id,
       (SELECT id FROM existing LIMIT 1) AS existing_id`,
    [
      auth.tenantId,
      auth.userId,
      runId,
      lockKey,
      JSON.stringify({
        guard: {
          claimedAt: new Date().toISOString(),
          policy: "one_daily_run_per_utc_day",
        },
      }),
    ]
  );

  const row = claim.rows[0];
  if (row?.inserted_id) {
    return { claimed: true, runId: row.inserted_id };
  }

  return {
    claimed: false,
    reason: "already_processed_today",
    existingRunId: row?.existing_id ?? null,
  };
}

export async function completeDailyIntelligenceRun(input: {
  auth: AuthContext;
  runId: string;
  status: "completed" | "failed";
  metadata: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `UPDATE daily_intelligence_runs
     SET status = $4,
         metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $5::jsonb,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [input.runId, input.auth.tenantId, input.auth.userId, input.status, JSON.stringify(input.metadata)]
  );
}

export async function markAlreadyProcessedSkip(input: {
  auth: AuthContext;
  existingRunId: string;
}): Promise<void> {
  await pool.query(
    `UPDATE daily_intelligence_runs
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND user_id = $3`,
    [
      input.existingRunId,
      input.auth.tenantId,
      input.auth.userId,
      JSON.stringify({
        duplicateAttempt: {
          skipped: true,
          skipReason: "already_processed_today",
          attemptedAt: new Date().toISOString(),
        },
      }),
    ]
  );
}

export async function userHasActiveMemoryRecords(auth: AuthContext): Promise<boolean> {
  const result = await pool.query<{ active_memory_count: number }>(
    `SELECT COUNT(*)::int AS active_memory_count
     FROM memory_records
     WHERE tenant_id = $1
       AND user_id = $2
       AND deleted_at IS NULL
       AND superseded_by IS NULL`,
    [auth.tenantId, auth.userId]
  );
  return (result.rows[0]?.active_memory_count ?? 0) > 0;
}

export async function hasAnyProcessedDailyRun(auth: AuthContext): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM daily_intelligence_runs
     WHERE tenant_id = $1
       AND user_id = $2
       AND status = 'completed'
       AND (
         metadata_json->>'processed' = 'true'
         OR metadata_json ? 'memoryCleanup'
       )
     LIMIT 1`,
    [auth.tenantId, auth.userId]
  );
  return result.rows.length > 0;
}
