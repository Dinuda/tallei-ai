import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { decryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { MemoryRepository } from "../../infrastructure/repositories/memory.repository.js";

const memoryRepository = new MemoryRepository();

export const workflowUserProfileMemorySchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  category: z.string().nullable().optional(),
  memoryType: z.string().optional(),
  tier: z.string().optional(),
});

export const workflowUserProfileSchema = z.object({
  capturedAt: z.string().min(1),
  memoryIds: z.array(z.string().uuid()),
  profileText: z.string().min(1),
  memories: z.array(workflowUserProfileMemorySchema).min(1),
});

export type WorkflowUserProfile = z.infer<typeof workflowUserProfileSchema>;
export type WorkflowUserProfileMemory = z.infer<typeof workflowUserProfileMemorySchema>;

function readRowText(row: { content_ciphertext: string }): string {
  try {
    return decryptMemoryContent(row.content_ciphertext).trim();
  } catch {
    return "";
  }
}

export function formatWorkflowUserProfile(profile: WorkflowUserProfile): string {
  return profile.memories
    .map((memory, index) => {
      const label = memory.category?.trim() || memory.memoryType || "profile";
      return `${index + 1}. [${memory.id}] (${label}) ${memory.text}`;
    })
    .join("\n");
}

export async function loadWorkflowUserProfile(auth: AuthContext): Promise<WorkflowUserProfile | null> {
  const rows = await memoryRepository.listWorkflowProfileMemories(auth, 32);
  const memories = rows
    .map((row) => ({
      id: row.id,
      text: readRowText(row),
      category: row.category,
      memoryType: row.memory_type,
      tier: row.tier,
    }))
    .filter((memory) => memory.text.length > 0);

  if (memories.length === 0) return null;

  const profileText = memories
    .map((memory, index) => {
      const label = memory.category?.trim() || memory.memoryType || "profile";
      return `${index + 1}. [${memory.id}] (${label}) ${memory.text}`;
    })
    .join("\n");

  return workflowUserProfileSchema.parse({
    capturedAt: new Date().toISOString(),
    memoryIds: memories.map((memory) => memory.id),
    memories,
    profileText,
  });
}

export function profileMemoryIds(profile: WorkflowUserProfile | null | undefined): Set<string> {
  return new Set(profile?.memoryIds ?? []);
}
