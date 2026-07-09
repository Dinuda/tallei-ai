export type HiddenToolSummaryViewModel = {
  title: string;
  subtitle?: string;
  variant?: "emerald" | "violet" | "amber" | "indigo";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeAnalyzeIntent(output: unknown): HiddenToolSummaryViewModel | null {
  if (!isRecord(output)) return null;
  const analysis = isRecord(output.analysis) ? output.analysis : output;
  const outcome = readString(analysis.outcome);
  const trigger = readString(analysis.trigger);
  if (!outcome && !trigger) return null;
  const subtitle = [outcome, trigger ? `Starts when ${trigger}` : null].filter(Boolean).join(" · ");
  return {
    title: "Captured the workflow intent",
    subtitle: subtitle || undefined,
    variant: "emerald",
  };
}

function summarizeDiscoverBindings(output: unknown): HiddenToolSummaryViewModel | null {
  if (!isRecord(output)) return null;
  if (output.ok === false) return null;
  const ambiguities = Array.isArray(output.ambiguities) ? output.ambiguities.length : 0;
  const suggestions = Array.isArray(output.suggestedBindings) ? output.suggestedBindings.length : 0;
  if (ambiguities === 0 && suggestions === 0) return null;
  const subtitle = ambiguities > 0
    ? `Found ${ambiguities} step${ambiguities === 1 ? "" : "s"} that need a closer look`
    : `Matched actions for ${suggestions} workflow step${suggestions === 1 ? "" : "s"}`;
  return {
    title: "Checked available actions",
    subtitle,
    variant: "indigo",
  };
}

function summarizeResolveBindings(output: unknown): HiddenToolSummaryViewModel | null {
  if (!isRecord(output)) return null;
  if (output.ok === false) return null;
  const pendingQuestions = Array.isArray(output.pendingQuestions) ? output.pendingQuestions.length : 0;
  if (pendingQuestions > 0) {
    return {
      title: "Prepared workflow setup choices",
      subtitle: `${pendingQuestions} question${pendingQuestions === 1 ? "" : "s"} ready for you`,
      variant: "amber",
    };
  }
  if (output.plan || output.ok === true) {
    return {
      title: "Resolved workflow actions",
      subtitle: "Bindings are ready for the next step",
      variant: "emerald",
    };
  }
  return null;
}

export function buildHiddenToolSummaryViewModel(
  toolName: string,
  output: unknown,
  state?: string,
): HiddenToolSummaryViewModel | null {
  if (state && state !== "output-available") return null;
  switch (toolName) {
    case "analyzeIntent":
      return summarizeAnalyzeIntent(output);
    case "discoverBindings":
      return summarizeDiscoverBindings(output);
    case "resolveBindings":
      return summarizeResolveBindings(output);
    default:
      return null;
  }
}
