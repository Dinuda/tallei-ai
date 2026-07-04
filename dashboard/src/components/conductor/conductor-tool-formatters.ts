export function formatCompileSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { ok?: boolean; plan?: { id: string; toolCount?: number }; errors?: unknown[]; error?: string };
  if (row.ok && row.plan) {
    const tools = row.plan.toolCount != null ? `${row.plan.toolCount} tools` : "runnable plan";
    return `Compiled ${tools}. Ready for test run.`;
  }
  if (row.errors?.length) return `Compile failed — ${row.errors.length} blocker(s)`;
  if (row.error) return row.error;
  if (row.ok === false) return "Compile could not run for the current build step.";
  return null;
}

export function formatTestRunSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as {
    ok?: boolean;
    status?: string;
    preview?: string;
    error?: string;
    steps?: Array<{ kind: string; capability?: string }>;
  };
  if (row.ok) {
    const toolStep = row.steps?.find((step) => step.kind === "tool");
    const toolNote = toolStep?.capability ? ` Simulated ${toolStep.capability}.` : "";
    return `Test passed.${toolNote} ${row.preview ?? ""}`.trim();
  }
  if (row.error) return `Test failed: ${row.error}`;
  return null;
}

export function formatActivateSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { ok?: boolean; status?: string; error?: string };
  if (row.ok) return `Loop is ${row.status ?? "active"}.`;
  if (row.error) return row.error;
  return null;
}

export function formatPatchSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as {
    missingSlots?: string[];
    spec?: {
      intent?: { outcome?: string };
      bindings?: Array<{ connector: string; capability: string }>;
      taskBlueprint?: { summary?: string };
    };
  };
  const outcome = row.spec?.intent?.outcome?.trim();
  const blueprint = row.spec?.taskBlueprint?.summary?.trim();
  const bindings = row.spec?.bindings?.map((b) => `${b.connector}:${b.capability}`).join(", ");
  const missing = row.missingSlots?.length ? `Still needed: ${row.missingSlots.join(", ")}` : "Ready to compile";
  if (outcome) return `${outcome}${bindings ? ` · Bindings: ${bindings}` : ""}. ${missing}`;
  if (blueprint) return `${blueprint}. ${missing}`;
  return bindings ? `Bindings: ${bindings}. ${missing}` : missing;
}

export function formatToolInputPreview(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;

  if (toolName === "discoverConnectorsForBlueprint" || toolName === "discoverBindings") {
    const role = typeof row.role === "string" ? row.role : null;
    const outcome = typeof row.outcomeDescription === "string"
      ? row.outcomeDescription
      : typeof row.outcome === "string"
        ? row.outcome
        : null;
    if (toolName === "discoverConnectorsForBlueprint" && Array.isArray(row.outcomes)) {
      return `${row.outcomes.length} outcome${row.outcomes.length === 1 ? "" : "s"}`;
    }
    if (role && outcome) return `${role}: ${outcome}`;
    if (outcome) return outcome;
    if (role) return role;
  }

  if (toolName === "connectToolkit" && typeof row.toolkit === "string") {
    return row.toolkit;
  }

  return null;
}

export function formatDiscoverConnectorsSummary(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as {
    askOptions?: unknown[];
    candidates?: Array<{ connector?: string; actionSlug?: string; name?: string }>;
    suggestedBindings?: Array<{ connector?: string; actionSlug?: string }>;
    selected?: { connector?: string; actionSlug?: string };
  };
  if (row.selected?.connector) {
    return `Selected ${row.selected.connector}${row.selected.actionSlug ? ` · ${row.selected.actionSlug}` : ""}`;
  }
  if (row.suggestedBindings?.length != null) {
    return `${row.suggestedBindings.length} binding${row.suggestedBindings.length === 1 ? "" : "s"} suggested`;
  }
  const count = row.askOptions?.length ?? row.candidates?.length;
  if (count != null) return `${count} option${count === 1 ? "" : "s"} ranked`;
  return null;
}
