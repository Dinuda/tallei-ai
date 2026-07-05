/** OpenCode Zen models that use `/chat/completions` (not `/responses` or Anthropic `/messages`). */
const OPENCODE_ZEN_CHAT_COMPLETIONS_PREFIXES = [
  "deepseek-",
  "minimax-",
  "glm-",
  "kimi-",
  "grok-build-",
  "big-pickle",
  "mimo-",
  "north-mini-code",
  "nemotron-",
] as const;

export function isOpenCodeZenChatCompletionsModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  return OPENCODE_ZEN_CHAT_COMPLETIONS_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
}

/** OpenCode Zen's Console upstream rejects forced tool choice (HTTP 400). */
export function resolveConductorToolChoice(
  activeToolCount: number,
  model: string,
): "auto" | "none" | "required" {
  if (activeToolCount === 0) return "none";
  if (isOpenCodeZenChatCompletionsModel(model)) return "auto";
  return "required";
}

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

/** Map cloud-only model names to the active OpenAI-compatible provider default. */
export function resolveChatModelForCompatibleProvider(
  configured: string,
  providerDefault: string,
): string {
  if (looksLikeHostedOpenAiModel(configured)) return providerDefault;
  return configured;
}
