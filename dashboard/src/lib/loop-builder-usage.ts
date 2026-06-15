export type BuilderLiveUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export function emptyBuilderLiveUsage(): BuilderLiveUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

export function normalizeBuilderLiveUsage(value: unknown): BuilderLiveUsage {
  if (!value || typeof value !== "object") return emptyBuilderLiveUsage();
  const record = value as Record<string, unknown>;
  return {
    promptTokens: typeof record.promptTokens === "number" ? record.promptTokens : 0,
    completionTokens: typeof record.completionTokens === "number" ? record.completionTokens : 0,
    totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : 0,
    estimatedCostUsd: typeof record.estimatedCostUsd === "number" ? record.estimatedCostUsd : 0,
  };
}

export function sumBuilderLiveUsage(...parts: Array<Partial<BuilderLiveUsage> | null | undefined>): BuilderLiveUsage {
  return parts.reduce<BuilderLiveUsage>((acc, part) => ({
    promptTokens: acc.promptTokens + (part?.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (part?.completionTokens ?? 0),
    totalTokens: acc.totalTokens + (part?.totalTokens ?? 0),
    estimatedCostUsd: Number((acc.estimatedCostUsd + (part?.estimatedCostUsd ?? 0)).toFixed(8)),
  }), emptyBuilderLiveUsage());
}
