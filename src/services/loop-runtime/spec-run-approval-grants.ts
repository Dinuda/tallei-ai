import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import type { RunPlanTool } from "./spec-run-plan.js";

export type SpecRunApprovalGrant = {
  interactionId: string;
  artifactKey?: string;
  approvedAt: string;
  authorizedActionRefs: string[];
  scope: "run" | "step";
  stepAttemptId?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function actionRefsForTool(tool: RunPlanTool): string[] {
  return unique([
    tool.toolKey,
    tool.toolRef,
    `${tool.toolkit}.${tool.actionSlug}`,
    tool.actionSlug,
  ]);
}

export async function storeSpecRunApprovalGrant(input: {
  auth: AuthContext;
  runId: string;
  grant: SpecRunApprovalGrant;
}): Promise<void> {
  await pool.query(
    `UPDATE loop_engine_runs
     SET context_json = context_json || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [
      input.runId,
      input.auth.tenantId,
      input.auth.userId,
      JSON.stringify({ approvalGrant: input.grant }),
    ],
  );
}

export async function loadSpecRunApprovalGrant(input: {
  auth: AuthContext;
  runId: string;
}): Promise<SpecRunApprovalGrant | null> {
  const result = await pool.query<{ context_json: unknown }>(
    `SELECT context_json
     FROM loop_engine_runs
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [input.runId, input.auth.tenantId, input.auth.userId],
  );
  const grant = asRecord(asRecord(result.rows[0]?.context_json).approvalGrant);
  const authorizedActionRefs = Array.isArray(grant.authorizedActionRefs)
    ? grant.authorizedActionRefs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (!authorizedActionRefs.length || typeof grant.interactionId !== "string") return null;
  return {
    interactionId: grant.interactionId,
    artifactKey: typeof grant.artifactKey === "string" ? grant.artifactKey : undefined,
    approvedAt: typeof grant.approvedAt === "string" ? grant.approvedAt : new Date().toISOString(),
    authorizedActionRefs,
    scope: grant.scope === "step" ? "step" : "run",
    stepAttemptId: typeof grant.stepAttemptId === "string" ? grant.stepAttemptId : undefined,
  };
}

export async function approvalGrantCoversAction(input: {
  auth: AuthContext;
  runId: string;
  stepAttemptId: string;
  actionRefs: string[];
}): Promise<SpecRunApprovalGrant | null> {
  const grant = await loadSpecRunApprovalGrant(input);
  if (!grant) return null;
  if (grant.scope === "step" && grant.stepAttemptId && grant.stepAttemptId !== input.stepAttemptId) {
    return null;
  }
  const allowed = new Set(grant.authorizedActionRefs.map((ref) => ref.toLowerCase()));
  return input.actionRefs.some((ref) => allowed.has(ref.toLowerCase())) ? grant : null;
}
