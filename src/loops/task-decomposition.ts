import { randomUUID } from "crypto";

import type { IntentExecutionStep } from "./intent-discovery.js";
import type { LoopSpec, OutcomeRole, TaskBlueprint } from "./spec.js";

export const OUTCOME_ROLE_ORDER: Record<OutcomeRole, number> = {
  trigger: 0,
  source: 1,
  transform: 2,
  destination: 3,
};

function outcomeRoleRank(role?: OutcomeRole): number {
  if (!role) return OUTCOME_ROLE_ORDER.transform;
  return OUTCOME_ROLE_ORDER[role] ?? OUTCOME_ROLE_ORDER.transform;
}

export function isMultiPhaseBlueprint(
  outcomes: Array<{ role?: OutcomeRole }>,
): boolean {
  let sawDestination = false;
  for (const outcome of outcomes) {
    if (outcome.role === "destination") sawDestination = true;
    if (sawDestination && (outcome.role === "trigger" || outcome.role === "source")) {
      return true;
    }
  }
  return false;
}

export function orderBlueprintOutcomes<T extends { role?: OutcomeRole }>(outcomes: T[]): T[] {
  return outcomes
    .map((outcome, index) => ({ outcome, index }))
    .sort((left, right) =>
      outcomeRoleRank(left.outcome.role) - outcomeRoleRank(right.outcome.role)
      || left.index - right.index,
    )
    .map(({ outcome }) => outcome);
}

export function outcomesMatchExecutionOrder(
  outcomes: Array<{ role: OutcomeRole; description: string }>,
  executionOrder: IntentExecutionStep[],
): boolean {
  if (executionOrder.length === 0) return false;
  if (outcomes.length !== executionOrder.length) return false;
  return outcomes.every((outcome, index) => {
    const step = executionOrder[index]!;
    return outcome.role === step.role
      && outcome.description.trim() === step.description.trim();
  });
}

export function normalizeBlueprintOutcomeOrder<T extends { role?: OutcomeRole; description: string }>(
  outcomes: T[],
  executionOrder: IntentExecutionStep[] = [],
): T[] {
  if (executionOrder.length > 0 && outcomesMatchExecutionOrder(
    outcomes.filter((outcome): outcome is T & { role: OutcomeRole } => Boolean(outcome.role)),
    executionOrder,
  )) {
    return outcomes;
  }
  if (isMultiPhaseBlueprint(outcomes)) return outcomes;
  return orderBlueprintOutcomes(outcomes);
}

export function buildOutcomesFromExecutionOrder(
  executionOrder: IntentExecutionStep[],
  existingOutcomes: TaskBlueprint["outcomes"] = [],
): TaskBlueprint["outcomes"] {
  const usedIds = new Set<string>();
  return executionOrder.map((step, index) => {
    const existing = existingOutcomes.find((outcome, outcomeIndex) =>
      !usedIds.has(outcome.id)
      && outcome.role === step.role
      && outcome.description.trim() === step.description.trim()
      && (outcomeIndex === index || !executionOrder.some((other, otherIndex) =>
        otherIndex !== index
        && other.role === outcome.role
        && other.description.trim() === outcome.description.trim(),
      )),
    ) ?? existingOutcomes.find((outcome) =>
      !usedIds.has(outcome.id)
      && outcome.role === step.role
      && outcome.description.trim() === step.description.trim(),
    );
    if (existing) usedIds.add(existing.id);
    return {
      id: existing?.id ?? randomUUID(),
      role: step.role,
      description: step.description,
      status: existing?.status ?? "pending",
      ...(existing?.selectedConnector ? { selectedConnector: existing.selectedConnector } : {}),
    };
  });
}

export function normalizeTaskBlueprint(
  blueprint: TaskBlueprint,
  executionOrder: IntentExecutionStep[] = [],
): TaskBlueprint {
  const normalizedOutcomes = blueprint.outcomes.map((outcome) => ({
    ...outcome,
    id: outcome.id?.trim() || randomUUID(),
    status: outcome.role !== "transform" && outcome.selectedConnector
      ? "chosen"
      : outcome.role !== "transform" && outcome.status === "chosen"
        ? "pending"
        : outcome.status ?? "pending",
  }));

  return {
    ...blueprint,
    outcomes: normalizeBlueprintOutcomeOrder(normalizedOutcomes, executionOrder),
  };
}

export function isBlueprintComplete(blueprint: TaskBlueprint | undefined): boolean {
  if (!blueprint?.outcomes.length) return false;
  const required = blueprint.outcomes.filter((outcome) => outcome.role !== "transform");
  return required.every((outcome) =>
    outcome.status === "skipped"
    || (outcome.status === "chosen" && Boolean(outcome.selectedConnector)),
  );
}

export function getPendingConnectorOutcomes(blueprint: TaskBlueprint | undefined): TaskBlueprint["outcomes"] {
  if (!blueprint) return [];
  return blueprint.outcomes.filter(
    (outcome) => outcome.role !== "transform"
      && (outcome.status !== "chosen" || !outcome.selectedConnector)
      && outcome.status !== "skipped",
  );
}

export function validateConnectorChoicesBeforeSpecPatch(
  current: LoopSpec,
  patch: import("./spec.js").SpecPatch,
): { ok: true } | { ok: false; error: string; pendingOutcomes?: TaskBlueprint["outcomes"] } {
  const touchesConnectors =
    patch.bindings !== undefined
    || (patch.trigger !== undefined && patch.trigger.kind === "event")
    || (patch.output?.connector !== undefined);

  if (!touchesConnectors) return { ok: true };

  if (!current.taskBlueprint && !patch.taskBlueprint) {
    return {
      ok: false,
      error: "Patch taskBlueprint via patchLoopSpec, then discoverConnectorsForBlueprint and pickConnectorApp before patching bindings, event triggers, or output.connector.",
    };
  }

  const merged = {
    ...current,
    taskBlueprint: patch.taskBlueprint ?? current.taskBlueprint,
  };
  const pending = getPendingConnectorOutcomes(merged.taskBlueprint);
  if (pending.length > 0) {
    return {
      ok: false,
      error: "Choose an app for each connector role via pickConnectorApp before patching bindings or triggers.",
      pendingOutcomes: pending,
    };
  }

  return { ok: true };
}

export function outcomeRoleLabel(role: OutcomeRole): string {
  switch (role) {
    case "source": return "Source";
    case "destination": return "Destination";
    case "trigger": return "Trigger";
    case "transform": return "Transform";
    default: return role;
  }
}
