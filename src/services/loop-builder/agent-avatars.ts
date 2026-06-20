import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import { dicebearDylanUrl } from "./agent-personas.js";

export type AgentAvatarView = {
  id: string;
  seed: string;
  style: string;
  url: string;
  status: "allocated" | "bound";
  boundSpecId: string | null;
  boundAgentId: string | null;
  boundAt: string | null;
  createdAt: string;
};

type AvatarRow = {
  id: string;
  style: string;
  seed: string;
  status: string;
  bound_spec_id: string | null;
  bound_agent_id: string | null;
  bound_at: Date | string | null;
  created_at: Date | string;
};

function mapAvatarRow(row: AvatarRow): AgentAvatarView {
  return {
    id: row.id,
    seed: row.seed,
    style: row.style,
    url: dicebearDylanUrl(row.seed),
    status: row.status === "bound" ? "bound" : "allocated",
    boundSpecId: row.bound_spec_id,
    boundAgentId: row.bound_agent_id,
    boundAt: row.bound_at ? new Date(row.bound_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function allocateAgentAvatars(
  auth: AuthContext,
  count = 1,
): Promise<AgentAvatarView[]> {
  const safeCount = Math.max(1, Math.min(20, Math.floor(count)));
  const seeds = Array.from({ length: safeCount }, () => randomUUID());
  const rows = await Promise.all(
    seeds.map((seed) =>
      pool.query<AvatarRow>(
        `INSERT INTO loop_agent_avatars (tenant_id, user_id, style, seed, status)
         VALUES ($1, $2, 'dylan', $3, 'allocated')
         RETURNING id, style, seed, status, bound_spec_id, bound_agent_id, bound_at, created_at`,
        [auth.tenantId, auth.userId, seed],
      )
    ),
  );
  return rows.map((result) => mapAvatarRow(result.rows[0]!));
}

export async function bindAgentAvatar(
  auth: AuthContext,
  avatarId: string,
  input: { specId: string; agentId: string },
): Promise<AgentAvatarView> {
  const existing = await pool.query<AvatarRow>(
    `SELECT id, style, seed, status, bound_spec_id, bound_agent_id, bound_at, created_at
     FROM loop_agent_avatars
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [avatarId, auth.tenantId, auth.userId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Avatar not found");
  if (row.status === "bound") throw new Error("Avatar is already bound and cannot be reused");

  const result = await pool.query<AvatarRow>(
    `UPDATE loop_agent_avatars
     SET status = 'bound',
         bound_spec_id = $4,
         bound_agent_id = $5,
         bound_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'allocated'
     RETURNING id, style, seed, status, bound_spec_id, bound_agent_id, bound_at, created_at`,
    [avatarId, auth.tenantId, auth.userId, input.specId, input.agentId],
  );
  if (!result.rows[0]) throw new Error("Avatar bind failed");
  return mapAvatarRow(result.rows[0]);
}

export async function releaseUnboundAvatarsForSpec(
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
