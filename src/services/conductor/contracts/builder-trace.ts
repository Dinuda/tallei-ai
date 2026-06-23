import { z } from "zod";

import { emptyLoopBuilderUsage, type LoopBuilderUsage } from "../utils/progress.js";

export const builderTraceEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  kind: z.enum(["analyzer_phase", "chat_turn"]),
  phase: z.string().optional(),
  agentLabel: z.string().optional(),
  systemPrompt: z.string().optional(),
  handoff: z.array(z.object({
    phase: z.string(),
    agentLabel: z.string(),
    summary: z.record(z.unknown()),
  })).optional(),
  usage: z.object({
    calls: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    estimatedCostUsd: z.number(),
    models: z.record(z.number()),
  }).optional(),
  messageCount: z.number().int().nonnegative().optional(),
});

export type BuilderTraceEntry = z.infer<typeof builderTraceEntrySchema>;

export function emptyBuilderTrace(): BuilderTraceEntry[] {
  return [];
}

export function normalizeBuilderTrace(value: unknown): BuilderTraceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = builderTraceEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function appendBuilderTraceEntries(
  existing: BuilderTraceEntry[],
  entries: BuilderTraceEntry[],
  maxEntries = 200,
): BuilderTraceEntry[] {
  return [...existing, ...entries].slice(-maxEntries);
}

export function usageToTraceUsage(usage: LoopBuilderUsage): BuilderTraceEntry["usage"] {
  return {
    calls: usage.calls,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    models: usage.models,
  };
}

export function emptyTraceUsage(): NonNullable<BuilderTraceEntry["usage"]> {
  const empty = emptyLoopBuilderUsage();
  return usageToTraceUsage(empty)!;
}
