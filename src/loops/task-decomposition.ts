import { randomUUID } from "crypto";

import type { LoopSpec, OutcomeRole, TaskBlueprint } from "./spec.js";

export type DecomposeTaskInput = {
  goal: string;
  outcome?: string;
  constraints?: string[];
};

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function decomposeTask(input: DecomposeTaskInput): TaskBlueprint {
  const combined = `${input.goal} ${input.outcome ?? ""} ${(input.constraints ?? []).join(" ")}`.toLowerCase();
  const outcomes: TaskBlueprint["outcomes"] = [];

  const wantsSchedule = hasAny(combined, [/daily|weekly|monthly|cron|schedule|every (day|week|morning)/]);
  const wantsEvent = hasAny(combined, [/when|incoming|new (email|message|ticket|lead)|on each|trigger|webhook|received/]);
  const wantsNewsletter = hasAny(combined, [/newsletter|digest|curate|roundup/]);
  const wantsSend = hasAny(combined, [/send|deliver|publish|notify|post to|email to|slack/]);
  const wantsRead = hasAny(combined, [/read|fetch|from notion|from google docs|from database|source|content from|pull/]);

  if (wantsEvent && !wantsSchedule) {
    outcomes.push({
      id: randomUUID(),
      role: "trigger",
      description: "When the loop should run (incoming event)",
      candidates: [],
      status: "pending",
    });
  } else if (wantsSchedule || wantsNewsletter) {
    outcomes.push({
      id: randomUUID(),
      role: "trigger",
      description: "When the loop should run (schedule)",
      candidates: [],
      status: "pending",
    });
  }

  outcomes.push({
    id: randomUUID(),
    role: "source",
    description: wantsNewsletter
      ? "Where to get content for the newsletter"
      : wantsRead
        ? "Where to read or fetch input data"
        : "Where the loop gets its input information",
    candidates: [],
    status: "pending",
  });

  if (hasAny(combined, [/summar|format|transform|draft|write|generate/])) {
    outcomes.push({
      id: randomUUID(),
      role: "transform",
      description: "How to shape or generate the content before delivery",
      candidates: [],
      status: "pending",
    });
  }

  if (wantsSend || wantsNewsletter || hasAny(combined, [/deliver|output|channel/])) {
    outcomes.push({
      id: randomUUID(),
      role: "destination",
      description: wantsNewsletter
        ? "How to send or publish the newsletter"
        : "Where results should be delivered",
      candidates: [],
      status: "pending",
    });
  }

  if (outcomes.length === 1) {
    outcomes.push({
      id: randomUUID(),
      role: "destination",
      description: "Where results should be delivered",
      candidates: [],
      status: "pending",
    });
  }

  return {
    version: 1,
    summary: input.outcome?.trim() || input.goal.trim(),
    outcomes,
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
      error: "Run decomposeTask, discoverConnectorsForBlueprint, and pickConnectorApp before patching bindings, event triggers, or output.connector.",
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
