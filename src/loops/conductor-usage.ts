export type ConductorChatUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export function emptyConductorChatUsage(): ConductorChatUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

export function finalizeConductorChatUsage(
  value: Partial<ConductorChatUsage> | null | undefined,
): ConductorChatUsage {
  const promptTokens = value?.promptTokens ?? 0;
  const completionTokens = value?.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: typeof value?.estimatedCostUsd === "number" ? value.estimatedCostUsd : 0,
  };
}

export function sumConductorChatUsage(
  ...parts: Array<Partial<ConductorChatUsage> | null | undefined>
): ConductorChatUsage {
  return finalizeConductorChatUsage(parts.reduce<ConductorChatUsage>((acc, part) => ({
    promptTokens: acc.promptTokens + (part?.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (part?.completionTokens ?? 0),
    totalTokens: 0,
    estimatedCostUsd: Number((acc.estimatedCostUsd + (part?.estimatedCostUsd ?? 0)).toFixed(8)),
  }), emptyConductorChatUsage()));
}

export function estimateConductorChatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const normalized = model.toLowerCase();
  const pricing = normalized.includes("gpt-5-nano")
    ? { input: 0.05, output: 0.4 }
    : normalized.includes("gpt-5-mini")
      ? { input: 0.25, output: 2 }
      : normalized.includes("gpt-5")
        ? { input: 1.25, output: 10 }
        : normalized.includes("gpt-4o-mini")
          ? { input: 0.15, output: 0.6 }
          : normalized.includes("gpt-4o")
            ? { input: 2.5, output: 10 }
            : normalized.includes("claude")
              ? { input: 3, output: 15 }
              : { input: 0, output: 0 };
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

type RawLanguageModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/** Map AI SDK v6 usage (`inputTokens`/`outputTokens`) and legacy provider fields. */
export function readTokenCountsFromLanguageModelUsage(
  usage: RawLanguageModelUsage,
): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
    completionTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
  };
}

export function usageFromLanguageModelStep(
  usage: RawLanguageModelUsage,
  model: string,
): ConductorChatUsage {
  const { promptTokens, completionTokens } = readTokenCountsFromLanguageModelUsage(usage);
  return finalizeConductorChatUsage({
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateConductorChatCostUsd(model, promptTokens, completionTokens),
  });
}

function readMessageUsage(message: { role?: string; metadata?: unknown }): ConductorChatUsage | null {
  if (message.role !== "assistant") return null;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const usage = (metadata as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const normalized = finalizeConductorChatUsage({
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
    estimatedCostUsd: typeof record.estimatedCostUsd === "number" ? record.estimatedCostUsd : 0,
  });
  if (normalized.promptTokens === 0 && normalized.completionTokens === 0 && normalized.estimatedCostUsd === 0) {
    return null;
  }
  return normalized;
}

export function sumConductorUsageFromMessages(
  messages: Array<{ role?: string; metadata?: unknown }>,
): ConductorChatUsage {
  return sumConductorChatUsage(
    ...messages
      .map((message) => readMessageUsage(message))
      .filter((usage): usage is ConductorChatUsage => usage != null),
  );
}

function readMessageSessionUsage(message: { role?: string; metadata?: unknown }): ConductorChatUsage | null {
  if (message.role !== "assistant") return null;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const sessionUsage = (metadata as Record<string, unknown>).sessionUsage;
  if (!sessionUsage || typeof sessionUsage !== "object") return null;
  const record = sessionUsage as Record<string, unknown>;
  const normalized = finalizeConductorChatUsage({
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
    estimatedCostUsd: typeof record.estimatedCostUsd === "number" ? record.estimatedCostUsd : 0,
  });
  if (normalized.promptTokens === 0 && normalized.completionTokens === 0 && normalized.estimatedCostUsd === 0) {
    return null;
  }
  return normalized;
}

/** Prefer the latest assistant sessionUsage snapshot; fall back to summing per-turn usage. */
export function deriveConductorSessionUsage(
  messages: Array<{ role?: string; metadata?: unknown }>,
): ConductorChatUsage {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const sessionUsage = readMessageSessionUsage(messages[index]!);
    if (sessionUsage) return sessionUsage;
  }
  return sumConductorUsageFromMessages(messages);
}

export function buildConductorSessionUsage(
  sessionUsageBase: ConductorChatUsage,
  turnUsage: ConductorChatUsage,
): ConductorChatUsage {
  return sumConductorChatUsage(sessionUsageBase, turnUsage);
}

export function maxConductorChatUsage(
  ...values: Array<ConductorChatUsage | null | undefined>
): ConductorChatUsage {
  return finalizeConductorChatUsage(values.reduce<ConductorChatUsage>((best, value) => {
    if (!value) return best;
    return {
      promptTokens: Math.max(best.promptTokens, value.promptTokens),
      completionTokens: Math.max(best.completionTokens, value.completionTokens),
      totalTokens: 0,
      estimatedCostUsd: Math.max(best.estimatedCostUsd, value.estimatedCostUsd),
    };
  }, emptyConductorChatUsage()));
}
