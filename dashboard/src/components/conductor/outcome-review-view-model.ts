export type OutcomeReviewStage = {
  identity: string;
  icon?: string;
  label: string;
  description: string;
  kind: "trigger" | "source" | "action" | "approval" | "result";
};

export type OutcomeReviewViewModel = {
  title: string;
  reversible: boolean;
  runsWhen: string;
  does: string;
  stages: OutcomeReviewStage[];
  approval: string;
  result: string;
};

export type LegacyOutcomeReviewSummary = {
  title?: string;
  reversible?: boolean;
  runsWhen?: string;
  does?: string;
  steps?: Array<{
    label?: string;
    description?: string;
    kind?: "trigger" | "action" | "approval" | "result";
  }>;
  approval?: string;
  result?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function approvalPresentation(approval: Record<string, unknown> | null): {
  copy: string;
  reversible: boolean;
} {
  const mode = text(approval?.mode) || "mixed";
  if (mode === "auto") {
    return { copy: "Runs automatically without an approval step.", reversible: false };
  }
  if (mode === "ask") {
    return { copy: "Waits for your approval before every action.", reversible: true };
  }
  return { copy: "Waits for your approval before sensitive actions.", reversible: true };
}

function triggerPresentation(
  trigger: Record<string, unknown> | null,
  triggerDescription: string,
): string {
  if (triggerDescription) return triggerDescription;
  const kind = text(trigger?.kind);
  if (kind === "manual") return "Starts when you run it.";
  if (kind === "schedule") return "Runs on its configured schedule.";
  if (kind === "event") {
    const source = text(trigger?.source);
    return source ? `Starts when an event arrives from ${humanize(source)}.` : "Starts when the configured event occurs.";
  }
  return "Start condition is not configured yet.";
}

function outputPresentation(
  output: Record<string, unknown> | null,
  destinationDescription: string,
): string {
  if (destinationDescription) return destinationDescription;
  const kind = text(output?.kind);
  const target = text(output?.target);
  if (!kind || kind === "none") return "Results remain in the apps used by the automation.";
  if (target) return `Results go to ${target}.`;
  return `Results are delivered through ${humanize(kind)}.`;
}

function legacyViewModel(summary: LegacyOutcomeReviewSummary): OutcomeReviewViewModel | null {
  if (!summary.title && !summary.runsWhen && !summary.does) return null;
  const stages = (summary.steps ?? []).flatMap((step): OutcomeReviewStage[] => {
    const label = text(step.label);
    const description = text(step.description);
    if (!label || !description) return [];
    const kind = step.kind === "trigger"
      ? "trigger"
      : step.kind === "approval"
        ? "approval"
        : step.kind === "result"
          ? "result"
          : "action";
    return [{ identity: kind === "approval" ? "You" : "Tallei", label, description, kind }];
  });
  return {
    title: text(summary.title) || "Automation plan",
    reversible: summary.reversible ?? false,
    runsWhen: text(summary.runsWhen) || "Start condition was not recorded.",
    does: text(summary.does) || "Automation details were not recorded.",
    stages,
    approval: text(summary.approval) || "Approval behavior was not recorded.",
    result: text(summary.result) || "Result destination was not recorded.",
  };
}

type SpecialistWorkflowStep = {
  role: "trigger" | "source" | "transform" | "destination";
  description: string;
  connector?: string;
};

function stageFromSpecialistStep(step: SpecialistWorkflowStep): OutcomeReviewStage {
  const role = step.role;
  const label = role === "trigger"
    ? "Starts when"
    : role === "source"
      ? "Reads from"
      : role === "destination"
        ? "Delivers through"
        : "Processes";
  const connectorSlug = text(step.connector).toLowerCase();
  const connector = humanize(connectorSlug);
  const identity = role === "transform"
    ? "Tallei"
    : role === "trigger"
      ? "Trigger"
      : connector || (role === "destination" ? "Destination" : "Source");

  return {
    identity,
    ...(connectorSlug ? { icon: connectorSlug } : {}),
    label,
    description: text(step.description) || "Configured stage",
    kind: role === "trigger"
      ? "trigger"
      : role === "source"
        ? "source"
        : role === "destination"
          ? "result"
          : "action",
  };
}

export function buildSpecialistWorkflowViewModel(input: {
  specialistName: string;
  roleTitle: string;
  ownershipSummary: string;
  steps: SpecialistWorkflowStep[];
}): OutcomeReviewViewModel {
  const stages = input.steps.map(stageFromSpecialistStep);
  const triggerStage = stages.find((stage) => stage.kind === "trigger");
  const resultStage = stages.find((stage) => stage.kind === "result");

  return {
    title: input.roleTitle.trim() || `${input.specialistName.trim()} workflow`,
    reversible: false,
    runsWhen: triggerStage?.description ?? input.ownershipSummary,
    does: input.ownershipSummary,
    stages,
    approval: "Handled by the team approval policy.",
    result: resultStage?.description ?? "Completes assigned workflow steps.",
  };
}

export function buildOutcomeReviewViewModel(
  spec: Record<string, unknown> | null,
  legacySummary?: LegacyOutcomeReviewSummary,
): OutcomeReviewViewModel {
  if (!spec) {
    return legacyViewModel(legacySummary ?? {}) ?? {
      title: "Automation plan",
      reversible: false,
      runsWhen: "Start condition is not available.",
      does: "Automation details are not available.",
      stages: [],
      approval: "Approval behavior is not available.",
      result: "Result destination is not available.",
    };
  }

  const intent = record(spec.intent);
  const blueprint = record(spec.taskBlueprint);
  const outcomes = Array.isArray(blueprint?.outcomes)
    ? blueprint.outcomes.map(record).filter((outcome): outcome is Record<string, unknown> => Boolean(outcome))
    : [];
  const approval = approvalPresentation(record(spec.approval));

  const roleCounts = new Map<string, number>();
  const baseStages = outcomes.map((outcome): OutcomeReviewStage => {
    const role = text(outcome.role) || "transform";
    const count = (roleCounts.get(role) ?? 0) + 1;
    roleCounts.set(role, count);
    const label = role === "trigger"
      ? "Starts when"
      : role === "source"
        ? "Reads from"
        : role === "destination"
          ? "Delivers through"
          : "Processes";
     
    const connector = humanize(text(outcome.selectedConnector));
    const connectorSlug = text(outcome.selectedConnector).toLowerCase();
    const identity = role === "transform"
      ? "Tallei"
      : role === "trigger"
        ? "Trigger"
        : connector || (role === "destination" ? "Destination" : "Source");
    return {
      identity,
      ...(connectorSlug ? { icon: connectorSlug } : {}),
      label,
      description: text(outcome.description) || "Configured stage",
      kind: role === "trigger" ? "trigger" : role === "source" ? "source" : role === "destination" ? "result" : "action",
    };
  });

  const firstResult = baseStages.findIndex((stage) => stage.kind === "result");
  const stages = [...baseStages];
  if (approval.reversible) {
    const approvalStage: OutcomeReviewStage = {
      identity: "You",
      label: "Reviews",
      description: "You review before sensitive actions",
      kind: "approval",
    };
    stages.splice(firstResult >= 0 ? firstResult : stages.length, 0, approvalStage);
  }

  const triggerDescription = outcomes.find((outcome) => text(outcome.role) === "trigger");
  const destinationDescription = outcomes.find((outcome) => text(outcome.role) === "destination");
  const outcome = text(intent?.outcome);
  const blueprintSummary = text(blueprint?.summary);

  return {
    title: blueprintSummary || outcome || text(intent?.goal) || "Automation plan",
    reversible: approval.reversible,
    runsWhen: triggerPresentation(record(spec.trigger), text(triggerDescription?.description)),
    does: outcome || blueprintSummary || "Completes the configured workflow.",
    stages,
    approval: approval.copy,
    result: outputPresentation(record(spec.output), text(destinationDescription?.description)),
  };
}
