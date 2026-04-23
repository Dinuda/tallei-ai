export interface ConflictHint {
  subject: string;
  platforms: string[];
  refs: Array<{ id: string; text: string; platform: string }>;
}

export function activitySignal(referenceCount: number, lastReferencedAt: string | null): number {
  const refBoost = 1 + Math.log1p(Math.max(1, referenceCount));
  if (!lastReferencedAt) return refBoost;
  const daysSinceAccess = Math.max(0, (Date.now() - new Date(lastReferencedAt).getTime()) / 86_400_000);
  const freshnessMult = Math.max(0.6, Math.exp(-daysSinceAccess / 21));
  return refBoost * freshnessMult;
}

export function confidenceTier(referenceCount: unknown): "HIGH" | "MED" | "UNCONFIRMED" {
  const count = typeof referenceCount === "number" ? referenceCount : 0;
  if (count >= 5) return "HIGH";
  if (count >= 2) return "MED";
  return "UNCONFIRMED";
}

export function detectConflicts(
  memories: Array<{ id: string; text: string; metadata: Record<string, unknown> }>
): ConflictHint[] {
  const bySubject = new Map<string, typeof memories>();
  for (const m of memories) {
    const subject = typeof m.metadata["subject"] === "string" ? m.metadata["subject"] : null;
    if (!subject) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject)!.push(m);
  }

  const hints: ConflictHint[] = [];
  for (const [subject, group] of bySubject) {
    if (group.length < 2) continue;
    const platforms = [...new Set(group.map((m) => {
      const p = m.metadata["platform"];
      return typeof p === "string" ? p : "unknown";
    }))];
    if (platforms.length < 2) continue;
    hints.push({
      subject,
      platforms,
      refs: group.map((m) => ({
        id: m.id,
        text: m.text.slice(0, 200),
        platform: typeof m.metadata["platform"] === "string" ? m.metadata["platform"] : "unknown",
      })),
    });
  }
  return hints;
}
