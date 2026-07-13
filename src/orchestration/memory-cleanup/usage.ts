import type { AppModelRequest, AppModelResponse } from "../../model/types.js";
import type { CleanupAiUsage } from "./types.js";

type Pricing = { inputPerMillion: number; outputPerMillion: number };

const DEFAULT_UNKNOWN_MODEL_PRICING: Pricing = { inputPerMillion: 0.2, outputPerMillion: 0.4 };

const PRICING_BY_MODEL: Record<string, Pricing> = {
  "gpt-5-nano": { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-gpt-5-nano": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

export function emptyCleanupAiUsage(): CleanupAiUsage {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
    estimatedCostUsd: 0,
    models: {},
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function pricingForModel(model: string): Pricing {
  const normalized = model.toLowerCase();
  for (const [key, value] of Object.entries(PRICING_BY_MODEL)) {
    if (normalized.includes(key)) return value;
  }
  return DEFAULT_UNKNOWN_MODEL_PRICING;
}

export function recordCleanupAiUsage(
  usage: CleanupAiUsage,
  request: Pick<AppModelRequest, "messages" | "model">,
  response: AppModelResponse,
): void {
  const promptEstimate = request.messages.reduce((sum, message) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return sum + estimateTokens(content);
  }, 0);
  const completionEstimate = estimateTokens(response.text ?? "");
  const promptTokens = response.usage?.promptTokens ?? 0;
  const completionTokens = response.usage?.completionTokens ?? 0;
  const totalTokens = response.usage?.totalTokens ?? (promptTokens + completionTokens);
  const billablePromptTokens = promptTokens > 0 ? promptTokens : promptEstimate;
  const billableCompletionTokens = completionTokens > 0 ? completionTokens : completionEstimate;
  const pricing = pricingForModel(response.model);

  usage.calls += 1;
  usage.promptTokens += promptTokens;
  usage.completionTokens += completionTokens;
  usage.totalTokens += totalTokens;
  usage.estimatedPromptTokens += promptEstimate;
  usage.estimatedCompletionTokens += completionEstimate;
  usage.estimatedTotalTokens += promptEstimate + completionEstimate;
  usage.models[response.model] = (usage.models[response.model] ?? 0) + 1;
  usage.estimatedCostUsd +=
    (billablePromptTokens / 1_000_000) * pricing.inputPerMillion +
    (billableCompletionTokens / 1_000_000) * pricing.outputPerMillion;
}

export function mergeCleanupAiUsage(target: CleanupAiUsage, source: CleanupAiUsage): void {
  target.calls += source.calls;
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedPromptTokens += source.estimatedPromptTokens;
  target.estimatedCompletionTokens += source.estimatedCompletionTokens;
  target.estimatedTotalTokens += source.estimatedTotalTokens;
  target.estimatedCostUsd += source.estimatedCostUsd;
  for (const [model, count] of Object.entries(source.models)) {
    target.models[model] = (target.models[model] ?? 0) + count;
  }
}
