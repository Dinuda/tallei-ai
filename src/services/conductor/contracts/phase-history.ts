import { z } from "zod";

import type { BuilderArtifactKey } from "../builder/phases/graph.js";
import type { BuilderAnalyzerPhase } from "../builder/phases/types.js";

export const phaseTransitionReasonSchema = z.enum([
  "auto_advance",
  "user_revision",
  "user_revision_confirmed",
]);

export const phaseTransitionEventSchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  from: z.enum(["discovery", "requirements", "compile", "verification"]),
  to: z.enum(["discovery", "requirements", "compile", "verification"]),
  reason: phaseTransitionReasonSchema,
  revisedArtifact: z.enum(["intent", "buildContract", "spec", "verification"]).optional(),
  invalidated: z.array(z.enum(["intent", "buildContract", "spec", "verification"])).default([]),
  preserved: z.array(z.enum(["intent", "buildContract", "spec", "verification"])).default([]),
  userMessageId: z.string().optional(),
});

export type PhaseTransitionEvent = z.infer<typeof phaseTransitionEventSchema>;

export const pendingPhaseRevisionSchema = z.object({
  targetPhase: z.enum(["discovery", "requirements", "compile", "verification"]),
  revisedArtifact: z.enum(["intent", "buildContract", "spec", "verification"]).nullable(),
  invalidated: z.array(z.enum(["intent", "buildContract", "spec", "verification"])).default([]),
  preserved: z.array(z.enum(["intent", "buildContract", "spec", "verification"])).default([]),
  reason: z.string().min(1),
  userMessageId: z.string().optional(),
  proposedAt: z.string().min(1),
});

export type PendingPhaseRevision = z.infer<typeof pendingPhaseRevisionSchema>;

export function normalizePhaseHistory(value: unknown): PhaseTransitionEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = phaseTransitionEventSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function normalizePendingRevision(value: unknown): PendingPhaseRevision | null {
  const parsed = pendingPhaseRevisionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function appendPhaseHistoryEntries(
  existing: PhaseTransitionEvent[],
  entries: PhaseTransitionEvent[],
  maxEntries = 100,
): PhaseTransitionEvent[] {
  return [...existing, ...entries].slice(-maxEntries);
}

export type { BuilderAnalyzerPhase, BuilderArtifactKey };
