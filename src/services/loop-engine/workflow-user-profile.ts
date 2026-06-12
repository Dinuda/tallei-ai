import { z } from "zod";

import type { AuthContext } from "../../domain/auth/index.js";
import { decryptMemoryContent } from "../../infrastructure/crypto/memory-crypto.js";
import { MemoryRepository } from "../../infrastructure/repositories/memory.repository.js";

const memoryRepository = new MemoryRepository();
const MAX_PROFILE_MEMORY_CHARS = 600;
const MAX_WORKFLOW_PROFILE_MEMORIES = 32;
const MAX_WORKFLOW_PROFILE_CANDIDATES = 256;

const FIRST_PARTY_PROFILE_PATTERNS: RegExp[] = [
  /\b(?:i|we)\s+(?:prefer|use|work|live|write|speak|avoid)\b/i,
  /\bi\s+(?:am\s+called|am\s+from)\b/i,
  /\b(?:my|our)\s+(?:name|email|phone|number|pronouns|timezone|time\s*zone|location|city|country|role|company|business|team|preferred|favou?rite)\b/i,
  /\b(?:user|the user)\s+(?:is|prefers|uses|works|lives|writes|speaks|avoids)\b/i,
  /^(?:always|never|avoid|keep|sign|use|write)\b/i,
];

const ASSISTANT_OUTPUT_PATTERNS: RegExp[] = [
  /^(?:sure|here(?:'s| is)|let me|i(?:'ll| will) help|looking at|from the data|got it)\b/i,
  /(?:^|\n)#{1,6}\s/m,
  /(?:^|\n)```/m,
  /<antArtifact\b/i,
];

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

export function isWorkflowUserProfileMemory(memory: {
  text: string;
  memoryType?: string;
}): boolean {
  const text = memory.text.trim();
  if (memory.memoryType !== "preference") return false;
  if (text.length === 0 || text.length > MAX_PROFILE_MEMORY_CHARS) return false;
  if (ASSISTANT_OUTPUT_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return FIRST_PARTY_PROFILE_PATTERNS.some((pattern) => pattern.test(text));
}

export function formatWorkflowUserProfile(profile: WorkflowUserProfile): string {
  return profile.memories
    .map((memory, index) => {
      const label = memory.category?.trim() || memory.memoryType || "profile";
      return `${index + 1}. [${memory.id}] (${label}) ${memory.text}`;
    })
    .join("\n");
}

export function sanitizeWorkflowUserProfile(profile: WorkflowUserProfile): WorkflowUserProfile | null {
  const memories = profile.memories
    .filter(isWorkflowUserProfileMemory)
    .slice(0, MAX_WORKFLOW_PROFILE_MEMORIES);
  if (memories.length === 0) return null;

  return workflowUserProfileSchema.parse({
    ...profile,
    memoryIds: memories.map((memory) => memory.id),
    memories,
    profileText: formatWorkflowUserProfile({ ...profile, memories }),
  });
}

export async function loadWorkflowUserProfile(auth: AuthContext): Promise<WorkflowUserProfile | null> {
  const rows = await memoryRepository.listWorkflowProfileMemories(auth, MAX_WORKFLOW_PROFILE_CANDIDATES);
  const memories = rows
    .map((row) => ({
      id: row.id,
      text: readRowText(row),
      category: row.category,
      memoryType: row.memory_type,
      tier: row.tier,
    }))
    .filter(isWorkflowUserProfileMemory)
    .slice(0, MAX_WORKFLOW_PROFILE_MEMORIES);

  if (memories.length === 0) return null;

  return sanitizeWorkflowUserProfile(workflowUserProfileSchema.parse({
    capturedAt: new Date().toISOString(),
    memoryIds: memories.map((memory) => memory.id),
    memories,
    profileText: "pending",
  }));
}

export function profileMemoryIds(profile: WorkflowUserProfile | null | undefined): Set<string> {
  return new Set(profile?.memoryIds ?? []);
}
