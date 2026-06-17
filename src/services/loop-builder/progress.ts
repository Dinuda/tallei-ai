import { AsyncLocalStorage } from "node:async_hooks";

export type LoopBuilderProgressEvent = {
  id: number;
  at: string;
  stage: string;
  message: string;
  status: "running" | "completed" | "failed";
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  details?: unknown;
};

export type LoopBuilderUsage = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  models: Record<string, number>;
};

type ProgressContext = {
  append: (event: Omit<LoopBuilderProgressEvent, "id" | "at">) => void;
};

const progressStorage = new AsyncLocalStorage<ProgressContext>();

export function sanitizeLoopBuilderProgressDetails(value: unknown): unknown {
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 1200) return "[truncated]";
    if (depth > 7) return "[max depth]";
    if (typeof current === "string") return current.length > 2000 ? `${current.slice(0, 2000)}…` : current;
    if (Array.isArray(current)) return current.slice(0, 40).map((item) => visit(item, depth + 1));
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current as Record<string, unknown>).slice(0, 80).map(([key, entry]) => [
      key,
      /secret|token|credential|authorization|api.?key|password/i.test(key) ? "[redacted]" : visit(entry, depth + 1),
    ]));
  };
  return visit(value, 0);
}

export function runWithLoopBuilderProgress<T>(context: ProgressContext, runner: () => Promise<T>): Promise<T> {
  return progressStorage.run(context, runner);
}

export function reportLoopBuilderProgress(event: Omit<LoopBuilderProgressEvent, "id" | "at">): void {
  progressStorage.getStore()?.append(event);
}

export function estimateLoopBuilderCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const normalized = model.toLowerCase();
  const pricing = normalized.includes("gpt-5-nano")
    ? { input: 0.05, output: 0.4 }
    : normalized.includes("gpt-5-mini")
      ? { input: 0.25, output: 2 }
      : normalized.includes("gpt-5")
        ? { input: 1.25, output: 10 }
        : normalized.includes("gpt-gpt-5-nano")
          ? { input: 0.15, output: 0.6 }
          : normalized.includes("gpt-4o")
            ? { input: 2.5, output: 10 }
            : { input: 0, output: 0 };
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

export function mergeLoopBuilderUsageTotals(...usages: LoopBuilderUsage[]): LoopBuilderUsage {
  const merged = usages.reduce<LoopBuilderUsage>((acc, usage) => {
    const models = { ...acc.models };
    for (const [model, count] of Object.entries(usage.models ?? {})) {
      models[model] = (models[model] ?? 0) + count;
    }
    return {
      calls: acc.calls + usage.calls,
      promptTokens: acc.promptTokens + usage.promptTokens,
      completionTokens: acc.completionTokens + usage.completionTokens,
      totalTokens: 0,
      estimatedCostUsd: Number((acc.estimatedCostUsd + usage.estimatedCostUsd).toFixed(8)),
      models,
    };
  }, emptyLoopBuilderUsage());
  merged.totalTokens = merged.promptTokens + merged.completionTokens;
  return merged;
}

export function usageFromLanguageModelStep(
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  model: string,
): LoopBuilderUsage {
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  return {
    calls: 1,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: estimateLoopBuilderCostUsd(model, promptTokens, completionTokens),
    models: { [model]: 1 },
  };
}

export function emptyLoopBuilderUsage(): LoopBuilderUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, models: {} };
}
