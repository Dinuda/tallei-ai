import type { ReasoningEffort } from "../config/load.js";

export function looksLikeHostedOpenAiModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("openai/")) return true;
  return normalized.startsWith("gpt-")
    || normalized.startsWith("o1")
    || normalized.startsWith("o3")
    || normalized.startsWith("o4");
}

export function coerceChatModelForLocalMode(
  configured: string,
  localModelMode: boolean,
  localDefault: string,
): string {
  if (!localModelMode) return configured;
  if (looksLikeHostedOpenAiModel(configured)) return localDefault;
  return configured;
}

/** Map OpenCode-style model names to the active OpenAI provider default. */
export function coerceChatModelForOpenAiProvider(
  configured: string,
  openAiDefault: string,
): string {
  if (looksLikeHostedOpenAiModel(configured)) return configured;
  return openAiDefault;
}

/** Map cloud-only model names to the active OpenAI-compatible provider default. */
export function resolveChatModelForCompatibleProvider(
  configured: string,
  providerDefault: string,
): string {
  if (looksLikeHostedOpenAiModel(configured)) return providerDefault;
  return configured;
}
