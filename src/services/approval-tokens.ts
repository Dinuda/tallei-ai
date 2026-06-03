import { createHash } from "crypto";

import { config } from "../config/index.js";
import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import type { ApprovalTargetType } from "./channels.js";

export async function createWorkflowApprovalRequest(input: {
  auth: AuthContext;
  targetType: ApprovalTargetType;
  targetId: string;
  channel: "email" | "gmail" | "whatsapp" | "telegram";
}): Promise<{ token: string; url: string }> {
  const token = createHash("sha256").update(`${input.auth.tenantId}:${input.auth.userId}:${input.targetType}:${input.targetId}:${Date.now()}`).digest("hex");
  await pool.query(
    `INSERT INTO workflow_approval_tokens
     (token, tenant_id, user_id, target_type, target_id, channel, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + interval '7 days')`,
    [token, input.auth.tenantId, input.auth.userId, input.targetType, input.targetId, input.channel]
  );

  return {
    token,
    url: `${config.publicBaseUrl.replace(/\/$/, "")}/api/workflows/approvals/${token}`,
  };
}

export async function resolveWorkflowApprovalToken(token: string): Promise<{
  tenantId: string;
  userId: string;
  targetType: string;
  targetId: string;
  channel: string;
  expired: boolean;
  consumedAt: string | null;
} | null> {
  const result = await pool.query<{
    tenant_id: string;
    user_id: string;
    target_type: string;
    target_id: string;
    channel: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT tenant_id, user_id, target_type, target_id, channel, expires_at, consumed_at
     FROM workflow_approval_tokens
     WHERE token = $1
     LIMIT 1`,
    [token]
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    targetType: row.target_type,
    targetId: row.target_id,
    channel: row.channel,
    expired: new Date(row.expires_at).getTime() < Date.now(),
    consumedAt: row.consumed_at,
  };
}

export async function consumeWorkflowApprovalToken(token: string): Promise<void> {
  await pool.query(
    `UPDATE workflow_approval_tokens
     SET consumed_at = NOW()
     WHERE token = $1
       AND consumed_at IS NULL`,
    [token]
  );
}
