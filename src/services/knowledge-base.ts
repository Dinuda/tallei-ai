import { randomUUID } from "crypto";
import { z } from "zod";

import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { requireWorkspaceId } from "./workspace/context.js";
import { saveWorkspaceMemory } from "./workspace-memory.js";

export const knowledgeBaseKindSchema = z.enum(["custom_faq", "google_doc"]);
export type KnowledgeBaseKind = z.infer<typeof knowledgeBaseKindSchema>;

export interface KnowledgeBaseView {
  id: string;
  name: string;
  kind: KnowledgeBaseKind;
  config: Record<string, unknown>;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseEntryView {
  id: string;
  knowledgeBaseId: string;
  question: string;
  answer: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBindingsView {
  talleiMemory: { enabled: true };
  workspaceMemory: { enabled: true };
  knowledgeBases: KnowledgeBaseView[];
}

function mapKnowledgeBase(row: {
  id: string;
  name: string;
  kind: string;
  config_json: unknown;
  entry_count: string | number;
  created_at: string;
  updated_at: string;
}): KnowledgeBaseView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "google_doc" ? "google_doc" : "custom_faq",
    config: row.config_json && typeof row.config_json === "object" && !Array.isArray(row.config_json)
      ? row.config_json as Record<string, unknown>
      : {},
    entryCount: Number(row.entry_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listKnowledgeBindings(auth: AuthContext): Promise<KnowledgeBindingsView> {
  const workspaceId = requireWorkspaceId(auth);
  const result = await pool.query<{
    id: string;
    name: string;
    kind: string;
    config_json: unknown;
    entry_count: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT kb.id, kb.name, kb.kind, kb.config_json, kb.created_at, kb.updated_at,
            COALESCE(COUNT(e.id), 0)::text AS entry_count
     FROM workspace_knowledge_bases kb
     LEFT JOIN workspace_knowledge_base_entries e ON e.knowledge_base_id = kb.id
     WHERE kb.tenant_id = $1
       AND kb.workspace_id = $2
     GROUP BY kb.id
     ORDER BY kb.updated_at DESC`,
    [auth.tenantId, workspaceId]
  );

  return {
    talleiMemory: { enabled: true },
    workspaceMemory: { enabled: true },
    knowledgeBases: result.rows.map(mapKnowledgeBase),
  };
}

export async function createKnowledgeBase(auth: AuthContext, input: {
  name: string;
  kind: KnowledgeBaseKind;
  config?: Record<string, unknown>;
}): Promise<KnowledgeBaseView> {
  const workspaceId = requireWorkspaceId(auth);
  const id = randomUUID();
  const result = await pool.query<{
    id: string;
    name: string;
    kind: string;
    config_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO workspace_knowledge_bases
       (id, tenant_id, workspace_id, user_id, name, kind, config_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id, name, kind, config_json, created_at, updated_at`,
    [id, auth.tenantId, workspaceId, auth.userId, input.name.trim(), input.kind, JSON.stringify(input.config ?? {})]
  );
  return mapKnowledgeBase({ ...result.rows[0], entry_count: 0 });
}

export async function listKnowledgeBaseEntries(auth: AuthContext, knowledgeBaseId: string): Promise<KnowledgeBaseEntryView[]> {
  const workspaceId = requireWorkspaceId(auth);
  const result = await pool.query<{
    id: string;
    knowledge_base_id: string;
    question: string;
    answer: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT e.id, e.knowledge_base_id, e.question, e.answer, e.sort_order, e.created_at, e.updated_at
     FROM workspace_knowledge_base_entries e
     INNER JOIN workspace_knowledge_bases kb ON kb.id = e.knowledge_base_id
     WHERE kb.id = $1
       AND kb.tenant_id = $2
       AND kb.workspace_id = $3
     ORDER BY e.sort_order ASC, e.created_at ASC`,
    [knowledgeBaseId, auth.tenantId, workspaceId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    question: row.question,
    answer: row.answer,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function upsertKnowledgeBaseEntry(auth: AuthContext, knowledgeBaseId: string, input: {
  id?: string;
  question: string;
  answer: string;
  sortOrder?: number;
}): Promise<KnowledgeBaseEntryView> {
  const workspaceId = requireWorkspaceId(auth);
  const kb = await pool.query<{ id: string }>(
    `SELECT id FROM workspace_knowledge_bases
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3`,
    [knowledgeBaseId, auth.tenantId, workspaceId]
  );
  if (!kb.rows[0]) throw new Error("Knowledge base not found");

  const entryId = input.id ?? randomUUID();
  const result = await pool.query<{
    id: string;
    knowledge_base_id: string;
    question: string;
    answer: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO workspace_knowledge_base_entries
       (id, knowledge_base_id, tenant_id, workspace_id, question, answer, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
       SET question = EXCLUDED.question,
           answer = EXCLUDED.answer,
           sort_order = EXCLUDED.sort_order,
           updated_at = NOW()
     RETURNING id, knowledge_base_id, question, answer, sort_order, created_at, updated_at`,
    [entryId, knowledgeBaseId, auth.tenantId, workspaceId, input.question.trim(), input.answer.trim(), input.sortOrder ?? 0]
  );

  await saveWorkspaceMemory(auth, {
    text: `FAQ: ${input.question.trim()}\nAnswer: ${input.answer.trim()}`,
    source: "faq_import",
    sourceRef: entryId,
    memoryType: "fact",
    category: "faq",
  });

  return {
    id: result.rows[0].id,
    knowledgeBaseId: result.rows[0].knowledge_base_id,
    question: result.rows[0].question,
    answer: result.rows[0].answer,
    sortOrder: result.rows[0].sort_order,
    createdAt: result.rows[0].created_at,
    updatedAt: result.rows[0].updated_at,
  };
}

export async function deleteKnowledgeBaseEntry(auth: AuthContext, knowledgeBaseId: string, entryId: string): Promise<void> {
  const workspaceId = requireWorkspaceId(auth);
  const result = await pool.query(
    `DELETE FROM workspace_knowledge_base_entries e
     USING workspace_knowledge_bases kb
     WHERE e.id = $1
       AND e.knowledge_base_id = $2
       AND kb.id = e.knowledge_base_id
       AND kb.tenant_id = $3
       AND kb.workspace_id = $4`,
    [entryId, knowledgeBaseId, auth.tenantId, workspaceId]
  );
  if (!result.rowCount) throw new Error("Knowledge base entry not found");
}

export async function searchKnowledgeBaseEntries(auth: AuthContext, query: string, knowledgeBaseIds?: string[]): Promise<KnowledgeBaseEntryView[]> {
  const workspaceId = requireWorkspaceId(auth);
  const trimmed = query.trim();
  if (!trimmed) return [];

  const result = await pool.query<{
    id: string;
    knowledge_base_id: string;
    question: string;
    answer: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT e.id, e.knowledge_base_id, e.question, e.answer, e.sort_order, e.created_at, e.updated_at
     FROM workspace_knowledge_base_entries e
     INNER JOIN workspace_knowledge_bases kb ON kb.id = e.knowledge_base_id
     WHERE kb.tenant_id = $1
       AND kb.workspace_id = $2
       AND ($3::uuid[] IS NULL OR kb.id = ANY($3::uuid[]))
       AND (e.question ILIKE '%' || $4 || '%' OR e.answer ILIKE '%' || $4 || '%')
     ORDER BY e.sort_order ASC
     LIMIT 12`,
    [auth.tenantId, workspaceId, knowledgeBaseIds?.length ? knowledgeBaseIds : null, trimmed]
  );

  return result.rows.map((row) => ({
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    question: row.question,
    answer: row.answer,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
