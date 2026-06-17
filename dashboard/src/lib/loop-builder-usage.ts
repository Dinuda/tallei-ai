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

export function normalizeBuilderLiveUsage(value: unknown): BuilderLiveUsage {
  if (!value || typeof value !== "object") return emptyBuilderLiveUsage();
  const record = value as Record<string, unknown>;
  return finalizeBuilderLiveUsage({
    promptTokens: typeof record.promptTokens === "number" ? record.promptTokens : 0,
    completionTokens: typeof record.completionTokens === "number" ? record.completionTokens : 0,
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
