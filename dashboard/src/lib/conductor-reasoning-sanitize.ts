/** Internal Conductor tools that must never appear in user-visible transcript copy. */
const INTERNAL_TOOL_REPLACEMENTS: ReadonlyArray<[pattern: RegExp, replacement: string]> = [
  [/\banalyzeIntent\b/g, "intent analysis"],
  [/\blistWorkspaceConnectors\b/g, "connected apps check"],
  [/\blistTriggers\b/g, "trigger lookup"],
  [/\blistActions\b/g, "action lookup"],
  [/\bdiscoverBindings\b/g, "action discovery"],
  [/\bresolveBindings\b/g, "workflow action setup"],
  [/\bdiscoverConnectorsForBlueprint\b/g, "app discovery"],
  [/\bpickConnectorApp\b/g, "app selection"],
  [/\bconnectToolkit\b/g, "app connection"],
  [/\baskQuestion\b/g, "follow-up question"],
  [/\bpresentAgentTeam\b/g, "specialist team review"],
  [/\bconfirmOutcomeBrief\b/g, "workflow confirmation"],
  [/\bpresentReplyOptions\b/g, "quick reply"],
  [/\bcompileLoop\b/g, "automation build"],
  [/\btestRunLoop\b/g, "test run"],
  [/\bactivateLoop\b/g, "activation"],
  [/\bpatchLoopSpec\b/g, "spec update"],
  [/\breviewOutcomeBrief\b/g, "workflow review"],
];

/**
 * Strip internal tool identifiers from reasoning summaries before transcript render.
 * OpenAI reasoning text is model-authored and can echo system-prompt tool names.
 */
export function sanitizeConductorReasoningForDisplay(text: string): string {
  let sanitized = text;
  for (const [pattern, replacement] of INTERNAL_TOOL_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.replace(/`([^`]+)`/g, (_, inner: string) => {
    const trimmed = inner.trim();
    const hit = INTERNAL_TOOL_REPLACEMENTS.find(([pattern]) => {
      pattern.lastIndex = 0;
      return pattern.test(trimmed);
    });
    return hit ? hit[1] : inner;
  });
}
