import type { PresentAgentTeamOutput } from "./conductor-shared";
import {
  specialistDisplayName,
  splitSpecialistsAroundReviewer,
} from "./workflow-rows-from-team";

export type ActivationSummaryStep = {
  step: number;
  what: string;
  who: string;
  connector?: string;
  avatarSeed?: string;
};

export type ActivationSummaryViewModel = {
  title: string;
  status: "active";
  alreadyActive: boolean;
  steps: ActivationSummaryStep[];
  preferences: string[];
  monitoringNote?: string;
};

export type ActivationLoopOutput = {
  ok?: boolean;
  alreadyActive?: boolean;
  eventTrigger?: { subscribed?: boolean } | null;
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

function approvalPreferenceLine(approval: Record<string, unknown> | null): string {
  const mode = text(approval?.mode) || "mixed";
  if (mode === "auto") return "Runs automatically without an approval step.";
  if (mode === "ask") return "Waits for your approval before every action.";
  return "Waits for your approval before sensitive actions.";
}

function isUserFacingAssumption(value: string): boolean {
  const lower = value.toLowerCase();
  return !/(connector|binding|trigger slug|composio|api slug|toolkit)/i.test(lower);
}

function buildPreferences(spec: Record<string, unknown> | null): string[] {
  if (!spec) return [];

  const preferences: string[] = [];
  const approvalLine = approvalPreferenceLine(record(spec.approval));
  if (approvalLine) preferences.push(approvalLine);

  const discovery = record(spec.intentDiscovery);
  const assumptions = Array.isArray(discovery?.assumptions)
    ? discovery.assumptions
        .map((entry) => text(entry))
        .filter((entry) => entry && isUserFacingAssumption(entry))
    : [];

  for (const assumption of assumptions) {
    if (!preferences.includes(assumption)) preferences.push(assumption);
  }

  return preferences;
}

function resolveTitle(
  team: PresentAgentTeamOutput | null | undefined,
  spec: Record<string, unknown> | null,
): string {
  const teamTitle = team?.title?.trim();
  if (teamTitle) return teamTitle;

  const intent = record(spec?.intent);
  const blueprint = record(spec?.taskBlueprint);
  return text(blueprint?.summary) || text(intent?.outcome) || text(intent?.goal) || "Automation";
}

function whoForSpecOutcome(outcome: Record<string, unknown>): string {
  const role = text(outcome.role) || "transform";
  const connector = humanize(text(outcome.selectedConnector));
  if (role === "trigger") return "Trigger";
  if (role === "transform") return "Tallei";
  if (role === "destination") return connector || "Destination";
  if (role === "source") return connector || "Source";
  return connector || "Tallei";
}

function buildStepsFromSpec(spec: Record<string, unknown> | null): ActivationSummaryStep[] {
  if (!spec) return [];

  const blueprint = record(spec.taskBlueprint);
  const outcomes = Array.isArray(blueprint?.outcomes)
    ? blueprint.outcomes.map(record).filter((outcome): outcome is Record<string, unknown> => Boolean(outcome))
    : [];

  const approval = record(spec.approval);
  const approvalMode = text(approval?.mode) || "mixed";
  const rows: ActivationSummaryStep[] = [];

  for (const outcome of outcomes) {
    const description = text(outcome.description);
    if (!description) continue;
    rows.push({
      step: rows.length + 1,
      what: description,
      who: whoForSpecOutcome(outcome),
      ...(text(outcome.selectedConnector) ? { connector: text(outcome.selectedConnector) } : {}),
    });
  }

  if (approvalMode !== "auto") {
    const firstDestination = rows.findIndex((row) => {
      const outcome = outcomes[rows.indexOf(row)];
      return text(outcome?.role) === "destination";
    });
    const reviewerRow: ActivationSummaryStep = {
      step: 0,
      what: approvalMode === "ask"
        ? "Reviews every action before it runs."
        : "Reviews sensitive actions before they run.",
      who: "You",
    };
    const insertAt = firstDestination >= 0 ? firstDestination : rows.length;
    rows.splice(insertAt, 0, reviewerRow);
  }

  return rows.map((row, index) => ({ ...row, step: index + 1 }));
}

function pushSpecialistSteps(
  rows: ActivationSummaryStep[],
  specialist: PresentAgentTeamOutput["specialists"][number],
): void {
  const name = specialistDisplayName(specialist.name);
  const who = `${name} · ${specialist.roleTitle}`;

  for (const step of specialist.steps) {
    if (step.role === "trigger") continue;
    const description = text(step.description);
    if (!description) continue;
    rows.push({
      step: rows.length + 1,
      what: description,
      who,
      ...(step.connector ? { connector: step.connector } : {}),
      avatarSeed: specialist.avatarSeed,
    });
  }
}

function buildStepsFromTeam(team: PresentAgentTeamOutput): ActivationSummaryStep[] {
  const rows: ActivationSummaryStep[] = [];

  for (const trigger of team.triggers ?? []) {
    const description = text(trigger.description);
    if (!description) continue;
    rows.push({
      step: rows.length + 1,
      what: description,
      who: "Trigger",
      ...(trigger.connector ? { connector: trigger.connector } : {}),
    });
  }

  const { reviewer, specialistsBefore, specialistsAfter } = splitSpecialistsAroundReviewer(team);

  for (const specialist of specialistsBefore) {
    pushSpecialistSteps(rows, specialist);
  }

  if (reviewer) {
    rows.push({
      step: rows.length + 1,
      what: reviewer.description || "Reviews sensitive actions before they run.",
      who: "You",
    });
  }

  for (const specialist of specialistsAfter) {
    pushSpecialistSteps(rows, specialist);
  }

  return rows.map((row, index) => ({ ...row, step: index + 1 }));
}

export function buildActivationSummaryViewModel(input: {
  team?: PresentAgentTeamOutput | null;
  spec?: Record<string, unknown> | null;
  output?: ActivationLoopOutput | null;
}): ActivationSummaryViewModel {
  const team = input.team;
  const spec = input.spec ?? null;
  const output = input.output ?? null;
  const steps = team?.specialists?.length
    ? buildStepsFromTeam(team)
    : buildStepsFromSpec(spec);

  const eventTrigger = output?.eventTrigger;
  const monitoringNote = eventTrigger && eventTrigger.subscribed !== false
    ? "Monitoring your inbox for new events."
    : undefined;

  return {
    title: resolveTitle(team, spec),
    status: "active",
    alreadyActive: output?.alreadyActive === true,
    steps,
    preferences: buildPreferences(spec),
    ...(monitoringNote ? { monitoringNote } : {}),
  };
}
