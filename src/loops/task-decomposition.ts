import { randomUUID } from "crypto";

import type { LoopSpec, OutcomeRole, TaskBlueprint } from "./spec.js";

export function normalizeTaskBlueprint(blueprint: TaskBlueprint): TaskBlueprint {
  return {
    ...blueprint,
    outcomes: blueprint.outcomes.map((outcome) => ({
      ...outcome,
      id: outcome.id?.trim() || randomUUID(),
      candidates: outcome.candidates ?? [],
      status: outcome.status ?? "pending",
    })),
  };
}

export function mergeBlueprintCandidates(
  blueprint: TaskBlueprint,
  outcomeId: string,
  candidates: TaskBlueprint["outcomes"][number]["candidates"],
  selectedConnector?: string,
): TaskBlueprint {
  return {
    ...blueprint,
    outcomes: blueprint.outcomes.map((outcome) => {
      if (outcome.id !== outcomeId) return outcome;
      return {
        ...outcome,
        candidates,
        ...(selectedConnector
          ? { selectedConnector, status: "chosen" as const }
          : {}),
      };
    }),
  };
}

export function isBlueprintComplete(blueprint: TaskBlueprint | undefined): boolean {
  if (!blueprint?.outcomes.length) return false;
  const required = blueprint.outcomes.filter((outcome) => outcome.role !== "transform");
  return required.every((outcome) => outcome.status === "chosen" || outcome.status === "skipped");
}

export function getPendingConnectorOutcomes(blueprint: TaskBlueprint | undefined): TaskBlueprint["outcomes"] {
  if (!blueprint) return [];
  return blueprint.outcomes.filter(
    (outcome) => outcome.role !== "transform" && outcome.status !== "chosen" && outcome.status !== "skipped",
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
      error: "Confirm the primary app via pickConnectorApp before patching bindings or triggers.",
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
