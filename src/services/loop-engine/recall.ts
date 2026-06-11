/**
 * recall.ts — Scored, multi-facet memory recall for the loop architect.
 */

import type { AuthContext } from "../../domain/auth/index.js";
import { recallMemories } from "../memory.js";
import { DESIGNER_MEMORY_TOP_K } from "./contracts.js";
import {
  loadWorkflowUserProfile,
  profileMemoryIds,
  type WorkflowUserProfile,
} from "./workflow-user-profile.js";

export interface ScoredMemory {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

function buildFacetQueries(prompt: string): string[] {
  const base = prompt.trim();
  return [
    `${base} deliverable output format structure sections`,
    `${base} voice tone style formatting audience preferences`,
    `${base} domain context prior work product updates`,
    `${base} recurring loop workflow agent patterns templates`,
  ];
}

function dedupeById(memories: ScoredMemory[]): ScoredMemory[] {
  const byId = new Map<string, ScoredMemory>();
  for (const memory of memories) {
    const existing = byId.get(memory.id);
    if (!existing || memory.score > existing.score) {
      byId.set(memory.id, memory);
    }
  }
  return [...byId.values()];
}

export async function recallForDesigner(
  prompt: string,
  auth: AuthContext,
  options?: {
    recall?: typeof recallMemories;
    topK?: number;
    profile?: WorkflowUserProfile | null;
  },
): Promise<ScoredMemory[]> {
  const recall = options?.recall ?? recallMemories;
  const topK = options?.topK ?? DESIGNER_MEMORY_TOP_K;
  const profile = options?.profile ?? await loadWorkflowUserProfile(auth).catch(() => null);
  const profileIds = profileMemoryIds(profile);
  const queries = buildFacetQueries(prompt);

  const resultSets = await Promise.all(
    queries.map((query) => recall(query, auth, 10).catch(() => ({ memories: [] }))),
  );

  const mandatoryProfileMemories: ScoredMemory[] = (profile?.memories ?? []).map((memory) => ({
    id: memory.id,
    text: memory.text,
    score: 1,
    metadata: { mandatory: true, profile: true, category: memory.category, memoryType: memory.memoryType },
  }));

  const merged = dedupeById([
    ...mandatoryProfileMemories,
    ...resultSets.flatMap((result) => (result.memories ?? []).map((memory) => ({
      id: memory.id,
      text: memory.text,
      score: memory.score ?? 0,
      metadata: memory.metadata,
    }))).filter((memory) => !profileIds.has(memory.id)),
  ])
    .sort((a, b) => b.score - a.score)
    .slice(0, topK + mandatoryProfileMemories.length);

  return merged;
}

export function formatMemoriesForArchitect(memories: ScoredMemory[]): string {
  if (memories.length === 0) return "No relevant memories found.";
  return memories
    .map((memory, index) => `${index + 1}. [${memory.id}] (score ${memory.score.toFixed(2)}) ${memory.text}`)
    .join("\n");
}
