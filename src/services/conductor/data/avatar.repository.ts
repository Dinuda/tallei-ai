import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";

export type AvatarRow = {
  id: string;
  style: string;
  seed: string;
  status: string;
  bound_spec_id: string | null;
  bound_agent_id: string | null;
  bound_at: Date | string | null;
  created_at: Date | string;
};

const AVATAR_COLUMNS = `id, style, seed, status, bound_spec_id, bound_agent_id, bound_at, created_at`;

export async function insertAllocatedAvatarRow(
  auth: AuthContext,
  seed: string,
): Promise<AvatarRow> {
  const result = await pool.query<AvatarRow>(
    `INSERT INTO loop_agent_avatars (tenant_id, user_id, style, seed, status)
     VALUES ($1, $2, 'dylan', $3, 'allocated')
     RETURNING ${AVATAR_COLUMNS}`,
    [auth.tenantId, auth.userId, seed],
  );
  return result.rows[0]!;
}

export async function findAvatarRow(
  auth: AuthContext,
  avatarId: string,
): Promise<AvatarRow | null> {
  const result = await pool.query<AvatarRow>(
    `SELECT ${AVATAR_COLUMNS}
     FROM loop_agent_avatars
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [avatarId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}

export async function bindAvatarRow(
  auth: AuthContext,
  avatarId: string,
  specId: string,
  agentId: string,
): Promise<AvatarRow | null> {
  const result = await pool.query<AvatarRow>(
    `UPDATE loop_agent_avatars
     SET status = 'bound',
         bound_spec_id = $4,
         bound_agent_id = $5,
         bound_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'allocated'
     RETURNING ${AVATAR_COLUMNS}`,
    [avatarId, auth.tenantId, auth.userId, specId, agentId],
  );
  return result.rows[0] ?? null;
}

export async function deleteUnboundAvatarsForSpec(
  auth: AuthContext,
  specId: string,
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM loop_agent_avatars
     WHERE tenant_id = $1 AND user_id = $2 AND bound_spec_id = $3 AND status = 'allocated'`,
    [auth.tenantId, auth.userId, specId],
  );
  return result.rowCount ?? 0;
}
