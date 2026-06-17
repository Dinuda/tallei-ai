import { createHash, randomUUID } from "crypto";

import type { AuthContext } from "../domain/auth/index.js";
import { config } from "../config/index.js";
import { encryptMemoryContent, decryptMemoryContent } from "../infrastructure/crypto/memory-crypto.js";
import { embedText } from "../infrastructure/cache/embedding-cache.js";
import { WorkspaceMemoryRepository } from "../infrastructure/repositories/workspace-memory.repository.js";
import { VectorRepository } from "../infrastructure/repositories/vector.repository.js";
import { requireWorkspaceId } from "./workspace/context.js";
import { noteVectorFailure, shouldBypassVector } from "./memory.js";

const workspaceMemoryRepository = new WorkspaceMemoryRepository();
const vectorRepository = new VectorRepository();

export interface WorkspaceMemoryView {
  id: string;
  text: string;
  source: string;
  sourceRef: string | null;
  memoryType: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: {
  id: string;
  content_ciphertext: string;
  source: string;
  source_ref: string | null;
  memory_type: string;
  category: string | null;
  created_at: string;
  updated_at: string;
}): WorkspaceMemoryView {
  return {
    id: row.id,
    text: decryptMemoryContent(row.content_ciphertext),
    source: row.source,
    sourceRef: row.source_ref,
    memoryType: row.memory_type,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { noteVectorFailure } from "./memory.js";

export async function saveWorkspaceMemory(auth: AuthContext, input: {
  text: string;
  source?: string;
  sourceRef?: string | null;
  memoryType?: string;
  category?: string | null;
}): Promise<WorkspaceMemoryView> {
  const workspaceId = requireWorkspaceId(auth);
  const text = input.text.trim();
  if (!text) throw new Error("Memory text is required");

  const id = randomUUID();
  const contentCiphertext = encryptMemoryContent(text);
  const contentHash = createHash("sha256").update(text).digest("hex");
  const placeholderPointId = `pending:${id}`;

  const row = await workspaceMemoryRepository.create({
    auth,
    workspaceId,
    id,
    contentCiphertext,
    contentHash,
    source: input.source ?? "manual",
    sourceRef: input.sourceRef ?? null,
    summaryJson: { preview: text.slice(0, 240) },
    qdrantPointId: placeholderPointId,
    memoryType: input.memoryType,
    category: input.category,
  });

  void (async () => {
    if (shouldBypassVector() || !config.qdrantUrl) return;
    try {
      const embedding = await embedText(text);
      const { pointId } = await vectorRepository.upsertWorkspaceMemoryVector({
        auth,
        workspaceId,
        memoryId: id,
        vector: embedding,
        source: input.source ?? "manual",
        createdAt: new Date().toISOString(),
      });
      await workspaceMemoryRepository.updateQdrantPointId(auth, workspaceId, id, pointId);
    } catch (error) {
      noteVectorFailure(error, "workspace_memory_save");
    }
  })();

  return mapRow(row);
}

export async function listWorkspaceMemories(auth: AuthContext, limit = 50): Promise<WorkspaceMemoryView[]> {
  const workspaceId = requireWorkspaceId(auth);
  const rows = await workspaceMemoryRepository.list(auth, workspaceId, limit);
  return rows.map(mapRow);
}

export async function deleteWorkspaceMemory(auth: AuthContext, memoryId: string): Promise<void> {
  const workspaceId = requireWorkspaceId(auth);
  const deleted = await workspaceMemoryRepository.delete(auth, workspaceId, memoryId);
  if (!deleted) throw new Error("Workspace memory not found");
}

export async function searchWorkspaceMemories(
  auth: AuthContext,
  query: string,
  limit = 12,
  options?: { workflowId?: string },
): Promise<WorkspaceMemoryView[]> {
  const workspaceId = requireWorkspaceId(auth);
  const trimmed = query.trim();
  const workflowPrefix = options?.workflowId ? `${options.workflowId}:` : null;

  const rankResults = (rows: WorkspaceMemoryView[]): WorkspaceMemoryView[] => {
    if (!workflowPrefix) return rows.slice(0, limit);
    return [...rows].sort((left, right) => {
      const leftBoost = left.sourceRef?.startsWith(workflowPrefix) ? 1 : 0;
      const rightBoost = right.sourceRef?.startsWith(workflowPrefix) ? 1 : 0;
      return rightBoost - leftBoost;
    }).slice(0, limit);
  };

  if (!trimmed) return rankResults(await listWorkspaceMemories(auth, limit));

  try {
    const embedding = await embedText(trimmed);
    const vectorHits = await vectorRepository.searchWorkspaceVectors(auth, workspaceId, embedding, limit * 2);
    const ids = vectorHits.map((hit) => hit.memoryId);
    const rows = await workspaceMemoryRepository.getByIds(auth, workspaceId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const mapped = vectorHits
      .map((hit) => byId.get(hit.memoryId))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map(mapRow);
    return rankResults(mapped);
  } catch {
    const rows = await workspaceMemoryRepository.searchByText(auth, workspaceId, trimmed, limit * 2);
    return rankResults(rows.map(mapRow));
  }
}

const MAX_LOOP_RUN_MEMORY_CHARS = 1200;

export async function persistLoopRunWorkspaceMemory(auth: AuthContext, input: {
  workflowId: string;
  runId: string;
  workflowTitle: string;
  approvedMemories?: Array<{ id: string; excerpt: string }>;
  artifactTexts?: string[];
}): Promise<void> {
  if (!auth.workspaceId) return;

  const chunks: Array<{ text: string; memoryType: string; category: string | null }> = [];
  const title = input.workflowTitle.trim() || "Loop";
  chunks.push({
    text: `Loop run completed for "${title}".`,
    memoryType: "fact",
    category: "loop_run",
  });

  for (const artifact of (input.artifactTexts ?? []).slice(0, 2)) {
    const trimmed = artifact.trim().slice(0, MAX_LOOP_RUN_MEMORY_CHARS);
    if (trimmed) {
      chunks.push({ text: trimmed, memoryType: "fact", category: "loop_output" });
    }
  }

  for (const memory of (input.approvedMemories ?? []).slice(0, 3)) {
    const trimmed = memory.excerpt.trim().slice(0, 600);
    if (trimmed) {
      chunks.push({ text: trimmed, memoryType: "preference", category: "loop_preference" });
    }
  }

  if (chunks.length === 0) return;

  const sourceRef = `${input.workflowId}:${input.runId}`;
  for (const chunk of chunks) {
    await saveWorkspaceMemory(auth, {
      text: chunk.text,
      source: "loop_run",
      sourceRef,
      memoryType: chunk.memoryType,
      category: chunk.category,
    });
  }
}
