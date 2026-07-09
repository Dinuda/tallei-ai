import type { UIMessage } from "ai";

export type BuilderLiveUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export function emptyBuilderLiveUsage(): BuilderLiveUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

/** Keep totals consistent: total always equals prompt + completion. */
export function finalizeBuilderLiveUsage(value: Partial<BuilderLiveUsage> | null | undefined): BuilderLiveUsage {
  const promptTokens = value?.promptTokens ?? 0;
  const completionTokens = value?.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: typeof value?.estimatedCostUsd === "number" ? value.estimatedCostUsd : 0,
  };
}

function readUsageTokenCounts(record: Record<string, unknown>): {
  promptTokens: number;
  completionTokens: number;
} {
  return {
    promptTokens: typeof record.promptTokens === "number"
      ? record.promptTokens
      : typeof record.inputTokens === "number"
        ? record.inputTokens
        : 0,
    completionTokens: typeof record.completionTokens === "number"
      ? record.completionTokens
      : typeof record.outputTokens === "number"
        ? record.outputTokens
        : 0,
  };
}

export function normalizeBuilderLiveUsage(value: unknown): BuilderLiveUsage {
  if (!value || typeof value !== "object") return emptyBuilderLiveUsage();
  const record = value as Record<string, unknown>;
  return finalizeBuilderLiveUsage({
    ...readUsageTokenCounts(record),
    estimatedCostUsd: typeof record.estimatedCostUsd === "number" ? record.estimatedCostUsd : 0,
  });
}

export function sumBuilderLiveUsage(...parts: Array<Partial<BuilderLiveUsage> | null | undefined>): BuilderLiveUsage {
  return finalizeBuilderLiveUsage(parts.reduce<BuilderLiveUsage>((acc, part) => ({
    promptTokens: acc.promptTokens + (part?.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (part?.completionTokens ?? 0),
    totalTokens: 0,
    estimatedCostUsd: Number((acc.estimatedCostUsd + (part?.estimatedCostUsd ?? 0)).toFixed(8)),
  }), emptyBuilderLiveUsage()));
}

export function readMessageUsage(message: UIMessage): BuilderLiveUsage | null {
  if (message.role !== "assistant") return null;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const usage = normalizeBuilderLiveUsage((metadata as Record<string, unknown>).usage);
  if (usage.promptTokens === 0 && usage.completionTokens === 0 && usage.estimatedCostUsd === 0) {
    return null;
  }
  return usage;
}

export function formatBuilderUsageLabel(usage: BuilderLiveUsage): string {
  return `${usage.promptTokens.toLocaleString()} in · ${usage.completionTokens.toLocaleString()} out · ${usage.totalTokens.toLocaleString()} total · $${usage.estimatedCostUsd.toFixed(4)}`;
}

export function deriveConductorUsageFromMessages(messages: UIMessage[]): BuilderLiveUsage {
  return sumBuilderLiveUsage(
    ...messages
      .map((message) => readMessageUsage(message))
      .filter((usage): usage is BuilderLiveUsage => usage != null),
  );
}

function readMessageSessionUsage(message: UIMessage): BuilderLiveUsage | null {
  if (message.role !== "assistant") return null;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const sessionUsage = (metadata as Record<string, unknown>).sessionUsage;
  if (!sessionUsage) return null;
  const usage = normalizeBuilderLiveUsage(sessionUsage);
  if (usage.promptTokens === 0 && usage.completionTokens === 0 && usage.estimatedCostUsd === 0) {
    return null;
  }
  return usage;
}

/** Use the latest assistant sessionUsage snapshot; fall back to summing per-turn usage. */
export function deriveConductorSessionUsage(messages: UIMessage[]): BuilderLiveUsage {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const sessionUsage = readMessageSessionUsage(messages[index]!);
    if (sessionUsage) return sessionUsage;
  }
  return deriveConductorUsageFromMessages(messages);
}

export function maxBuilderLiveUsage(
  ...values: Array<BuilderLiveUsage | null | undefined>
): BuilderLiveUsage {
  return finalizeBuilderLiveUsage(values.reduce<BuilderLiveUsage>((best, value) => {
    if (!value) return best;
    return {
      promptTokens: Math.max(best.promptTokens, value.promptTokens),
      completionTokens: Math.max(best.completionTokens, value.completionTokens),
      totalTokens: 0,
      estimatedCostUsd: Math.max(best.estimatedCostUsd, value.estimatedCostUsd),
    };
  }, emptyBuilderLiveUsage()));
}

export function formatBuilderUsageCompact(usage: BuilderLiveUsage): string {
  const tokens = usage.totalTokens >= 1_000_000
    ? `${(usage.totalTokens / 1_000_000).toFixed(2)}M tok`
    : usage.totalTokens >= 10_000
      ? `${Math.round(usage.totalTokens / 1_000)}k tok`
      : usage.totalTokens >= 1_000
        ? `${(usage.totalTokens / 1_000).toFixed(1)}k tok`
        : `${usage.totalTokens.toLocaleString()} tok`;
  return `${tokens} · $${usage.estimatedCostUsd.toFixed(4)}`;
}
