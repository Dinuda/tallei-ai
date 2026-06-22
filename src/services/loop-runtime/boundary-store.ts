import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import {
  agentBoundaryEnvelopeSchema,
  boundaryRouterDecisionSchema,
  projectStepOutputFromBoundary,
  type AgentBoundaryEnvelope,
  type BoundaryRouterDecision,
} from "./runner-boundary.js";

type BoundaryRecordLike = {
  protocol_version?: string | null;
  raw_output_json?: unknown;
  structured_output_json?: unknown;
  normalized_output_json?: unknown;
  normalized_handoff_json?: unknown;
  goal_eval_json?: unknown;
  router_decision?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

export function boundaryEnvelopeFromRecord(row: BoundaryRecordLike): AgentBoundaryEnvelope | null {
  if (!row.protocol_version) return null;
  const parsed = agentBoundaryEnvelopeSchema.safeParse({
    protocolVersion: row.protocol_version,
    rawOutput: row.raw_output_json,
    structuredOutput: row.structured_output_json,
    normalizedOutput: asRecord(row.normalized_output_json),
    normalizedHandoff: asRecord(row.normalized_handoff_json),
    goalEval: row.goal_eval_json,
  });
  return parsed.success ? parsed.data : null;
}

export function projectOutputWithBoundary(input: {
  outputJson: unknown;
  boundary: BoundaryRecordLike;
}): unknown {
  const envelope = boundaryEnvelopeFromRecord(input.boundary);
  if (!envelope) return input.outputJson;
  const output = asRecord(input.outputJson);
  const text = typeof output.text === "string" ? output.text : undefined;
  return projectStepOutputFromBoundary({ envelope, text });
}

export async function persistStepBoundary(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  status: "waiting_for_interaction" | "succeeded";
  envelope: AgentBoundaryEnvelope;
  routerDecision: BoundaryRouterDecision;
  boundaryIssues?: string[];
  evaluatorMetadata?: Record<string, unknown>;
  projectedOutputJson: Record<string, unknown>;
}): Promise<void> {
  boundaryRouterDecisionSchema.parse(input.routerDecision);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO loop_engine_boundaries
         (tenant_id, user_id, run_id, step_attempt_id, protocol_version,
          raw_output_json, structured_output_json, normalized_output_json, normalized_handoff_json,
          goal_eval_json, router_decision, boundary_issues_json, evaluator_metadata_json,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5,
               $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::jsonb, $11, $12::jsonb, $13::jsonb,
               NOW(), NOW())
       ON CONFLICT (step_attempt_id) DO UPDATE
       SET protocol_version = EXCLUDED.protocol_version,
           raw_output_json = EXCLUDED.raw_output_json,
           structured_output_json = EXCLUDED.structured_output_json,
           normalized_output_json = EXCLUDED.normalized_output_json,
           normalized_handoff_json = EXCLUDED.normalized_handoff_json,
           goal_eval_json = EXCLUDED.goal_eval_json,
           router_decision = EXCLUDED.router_decision,
           boundary_issues_json = EXCLUDED.boundary_issues_json,
           evaluator_metadata_json = EXCLUDED.evaluator_metadata_json,
           updated_at = NOW()`,
      [
        input.auth.tenantId,
        input.auth.userId,
        input.runId,
        input.stepAttemptId,
        input.envelope.protocolVersion,
        jsonParam(input.envelope.rawOutput),
        jsonParam(input.envelope.structuredOutput),
        jsonParam(input.envelope.normalizedOutput),
        jsonParam(input.envelope.normalizedHandoff),
        jsonParam(input.envelope.goalEval),
        input.routerDecision,
        jsonParam(input.boundaryIssues ?? []),
        jsonParam(input.evaluatorMetadata ?? {}),
      ],
    );
    await client.query(
      `UPDATE loop_engine_step_attempts
       SET status = $5,
           output_json = $2::jsonb,
           error_json = '{}'::jsonb,
           finished_at = CASE WHEN $5 = 'succeeded' THEN NOW() ELSE finished_at END,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $3 AND user_id = $4`,
      [
        input.stepAttemptId,
        jsonParam(input.projectedOutputJson),
        input.auth.tenantId,
        input.auth.userId,
        input.status,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
