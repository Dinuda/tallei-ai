import type { AuthContext } from "../../../domain/auth/index.js";
import { pool } from "../../../infrastructure/db/index.js";
import type { NoSlopSpecSnapshot } from "../contracts/spec-contracts.js";

export type LoopSpecRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  version: number;
  source_prompt: string;
  intent_context_json?: unknown;
  body_markdown: string;
  spec_json: unknown;
  approved_at: string | Date | null;
  approved_by_user_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const LOOP_SPEC_COLUMNS = `id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json,
  approved_at, approved_by_user_id, created_at, updated_at`;

export async function loopSpecExists(auth: AuthContext, specId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM loop_specs WHERE id = $1 AND tenant_id = $2 AND user_id = $3 LIMIT 1`,
    [specId, auth.tenantId, auth.userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function upsertApprovedLoopSpecRow(
  auth: AuthContext,
  parsed: NoSlopSpecSnapshot,
  sourcePrompt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO loop_specs
       (id, tenant_id, user_id, slug, title, status, version, source_prompt, body_markdown, spec_json, intent_context_json, approved_at, approved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz, $12)
     ON CONFLICT (id) DO UPDATE
       SET slug = EXCLUDED.slug,
           title = EXCLUDED.title,
           status = 'approved',
           version = EXCLUDED.version,
           source_prompt = EXCLUDED.source_prompt,
           body_markdown = EXCLUDED.body_markdown,
           spec_json = EXCLUDED.spec_json,
           intent_context_json = EXCLUDED.intent_context_json,
           approved_at = EXCLUDED.approved_at,
           approved_by_user_id = EXCLUDED.approved_by_user_id,
           updated_at = NOW()`,
    [
      parsed.id,
      auth.tenantId,
      auth.userId,
      parsed.slug,
      parsed.title,
      parsed.version,
      sourcePrompt,
      parsed.bodyMarkdown,
      JSON.stringify(parsed.specJson),
      parsed.intentContext ? JSON.stringify(parsed.intentContext) : null,
      parsed.approvedAt,
      auth.userId,
    ],
  );
}

export async function repairLoopSpecRow(
  auth: AuthContext,
  specId: string,
  specJson: string,
  bodyMarkdown: string,
): Promise<void> {
  await pool.query(
    `UPDATE loop_specs
     SET spec_json = $4::jsonb, body_markdown = $5, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [specId, auth.tenantId, auth.userId, specJson, bodyMarkdown],
  );
}

export async function listLoopSpecRows(auth: AuthContext): Promise<LoopSpecRow[]> {
  const result = await pool.query<LoopSpecRow>(
    `SELECT ${LOOP_SPEC_COLUMNS}
     FROM loop_specs
     WHERE tenant_id = $1 AND user_id = $2 AND status <> 'archived'
     ORDER BY updated_at DESC
     LIMIT 100`,
    [auth.tenantId, auth.userId],
  );
  return result.rows;
}

export async function findLoopSpecRow(
  auth: AuthContext,
  specId: string,
): Promise<LoopSpecRow | null> {
  const result = await pool.query<LoopSpecRow>(
    `SELECT ${LOOP_SPEC_COLUMNS}
     FROM loop_specs
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
     LIMIT 1`,
    [specId, auth.tenantId, auth.userId],
  );
  return result.rows[0] ?? null;
}
