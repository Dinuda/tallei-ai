import type { AuthContext } from "../../../domain/auth/index.js";

export async function runCuratedMemorySearch(_input: {
  auth: AuthContext;
  goal: string;
  agent: { id: string; name: string; task: string; tools: unknown[]; handoffBindings: unknown[] };
}): Promise<{ sources: Array<{ id: string; text: string }> }> {
  return { sources: [] };
}
