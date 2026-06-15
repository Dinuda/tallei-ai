import type { AuthContext } from "../domain/auth/index.js";
import { pool } from "../infrastructure/db/index.js";
import { runCuratedMemorySearch } from "./loop-runtime/curated-memory-search.js";
import { searchKnowledgeBaseEntries } from "./knowledge-base.js";
import { searchWorkspaceMemories } from "./workspace-memory.js";

export type GroundingSource =
  | { type: "tallei_memory" }
  | { type: "workspace_memory" }
  | { type: "knowledge_base"; id: string }
  | { type: "google_doc"; id: string };

export interface GroundedKnowledgeSource {
  id: string;
  text: string;
  origin: "tallei" | "workspace" | "faq" | "google_doc";
  title?: string;
}

export async function runGroundedKnowledgeSearch(input: {
  auth: AuthContext;
  goal: string;
  sources: GroundingSource[];
  workflowId?: string;
}): Promise<{ sources: GroundedKnowledgeSource[] }> {
  const enabled = input.sources.length > 0 ? input.sources : [
    { type: "tallei_memory" as const },
    { type: "workspace_memory" as const },
  ];

  const tasks: Array<Promise<GroundedKnowledgeSource[]>> = [];

  for (const source of enabled) {
    if (source.type === "tallei_memory") {
      tasks.push((async () => {
        const result = await runCuratedMemorySearch({
          auth: input.auth,
          goal: input.goal,
          agent: { id: "grounding", name: "Grounding", task: input.goal, tools: [], handoffBindings: [] },
        });
        return result.sources.map((entry) => ({
          id: entry.id,
          text: entry.text,
          origin: "tallei" as const,
          title: entry.text.slice(0, 80),
        }));
      })());
    } else if (source.type === "workspace_memory") {
      tasks.push((async () => {
        const memories = await searchWorkspaceMemories(input.auth, input.goal, 8, {
          workflowId: input.workflowId,
        });
        return memories.map((entry) => ({
          id: entry.id,
          text: entry.text,
          origin: "workspace" as const,
          title: entry.text.slice(0, 80),
        }));
      })());
    } else if (source.type === "knowledge_base") {
      tasks.push((async () => {
        const entries = await searchKnowledgeBaseEntries(input.auth, input.goal, [source.id]);
        return entries.map((entry) => ({
          id: entry.id,
          text: `Q: ${entry.question}\nA: ${entry.answer}`,
          origin: "faq" as const,
          title: entry.question,
        }));
      })());
    } else if (source.type === "google_doc") {
      tasks.push((async () => {
        const memories = await searchWorkspaceMemories(input.auth, input.goal, 8, {
          workflowId: input.workflowId,
        });
        return memories
          .filter((entry) => entry.source === "google_doc")
          .map((entry) => ({
            id: entry.id,
            text: entry.text,
            origin: "google_doc" as const,
            title: entry.sourceRef ?? "Google Doc",
          }));
      })());
    }
  }

  const batches = await Promise.all(tasks);
  const merged = new Map<string, GroundedKnowledgeSource>();
  for (const batch of batches) {
    for (const item of batch) {
      merged.set(`${item.origin}:${item.id}`, item);
    }
  }

  return { sources: [...merged.values()].slice(0, 12) };
}

export async function syncGoogleDocKnowledgeBase(auth: AuthContext, knowledgeBaseId: string): Promise<{
  syncedChunks: number;
  lastSyncedAt: string;
}> {
  const workspaceId = auth.workspaceId;
  if (!workspaceId) throw new Error("Workspace context is required");

  const kb = await pool.query<{ id: string; kind: string; config_json: unknown }>(
    `SELECT id, kind, config_json
     FROM workspace_knowledge_bases
     WHERE id = $1
       AND tenant_id = $2
       AND workspace_id = $3`,
    [knowledgeBaseId, auth.tenantId, workspaceId]
  );
  const row = kb.rows[0];
  if (!row || row.kind !== "google_doc") throw new Error("Google Doc knowledge base not found");

  const config = row.config_json && typeof row.config_json === "object" && !Array.isArray(row.config_json)
    ? row.config_json as Record<string, unknown>
    : {};
  const docText = typeof config.cachedText === "string" ? config.cachedText : "";
  const url = typeof config.url === "string" ? config.url : "";
  const title = typeof config.title === "string" ? config.title : "Google Doc";

  if (!docText.trim() && !url.trim()) {
    throw new Error("Link a Google Doc URL and content before syncing");
  }

  const chunks = (docText.trim() || title)
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(0, 40);

  const { saveWorkspaceMemory } = await import("./workspace-memory.js");
  for (const [index, chunk] of chunks.entries()) {
    await saveWorkspaceMemory(auth, {
      text: chunk,
      source: "google_doc",
      sourceRef: `${knowledgeBaseId}:${index}`,
      memoryType: "fact",
      category: "google_doc",
    });
  }

  const lastSyncedAt = new Date().toISOString();
  await pool.query(
    `UPDATE workspace_knowledge_bases
     SET config_json = config_json || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2
       AND workspace_id = $3`,
    [knowledgeBaseId, auth.tenantId, workspaceId, JSON.stringify({ lastSyncedAt, title, url })]
  );

  return { syncedChunks: chunks.length, lastSyncedAt };
}
