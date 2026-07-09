import type {
  AgentTeamSpecialist,
  PresentAgentTeamOutput,
} from "./conductor-shared";
import {
  specialistDisplayName,
  splitSpecialistsAroundReviewer,
} from "./workflow-rows-from-team";
import { buildBeatStepData, type TestRunBeatDataSection } from "./test-run-step-data";

export type TestRunBeatStatus = "pending" | "active" | "completed" | "failed" | "skipped";
export type TestRunBeatKind = "trigger" | "specialist" | "approval" | "result";

export type { TestRunBeatDataSection };

export type TestRunStoryBeat = {
  id: string;
  kind: TestRunBeatKind;
  status: TestRunBeatStatus;
  title: string;
  subtitle: string;
  narrative: string;
  artifact?: string;
  errors?: string[];
  stepData?: TestRunBeatDataSection[];
  avatarSeed?: string;
  specialistId?: string;
};

export type TestRunScenarioInput = {
  label: string;
  triggerPayload?: Record<string, unknown>;
  context?: string;
};

type TestRunStep = {
  kind: string;
  capability?: string;
  toolId?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
  decision?: Record<string, unknown>;
};

type TestRunOutput = {
  ok?: boolean;
  status?: string;
  preview?: string;
  error?: string;
  steps?: TestRunStep[];
};

export type TestRunStoryboardViewModel = {
  title: string;
  beats: TestRunStoryBeat[];
  footer: "running" | "passed" | "failed" | null;
  errorMessage?: string;
  errors?: string[];
};

function specialistActionSummary(specialist: AgentTeamSpecialist): string {
  const stepDescriptions = specialist.steps
    .filter((step) => step.role !== "trigger")
    .map((step) => step.description.trim())
    .filter(Boolean);

  if (stepDescriptions.length > 0) {
    return stepDescriptions.join(" ");
  }

  return specialist.ownershipSummary || specialist.description;
}

function specialistNarrative(specialist: AgentTeamSpecialist): string {
  return specialistActionSummary(specialist);
}

function buildBaseBeats(input: {
  team?: PresentAgentTeamOutput | null;
  scenario?: TestRunScenarioInput;
}): TestRunStoryBeat[] {
  const beats: TestRunStoryBeat[] = [];
  const team = input.team;
  const scenario = input.scenario;

  const triggerDescription = team?.triggers?.[0]?.description
    ?? scenario?.context
    ?? scenario?.label
    ?? "Configured trigger fires.";

  beats.push({
    id: "trigger",
    kind: "trigger",
    status: "pending",
    title: "Starts when",
    subtitle: "Trigger",
    narrative: triggerDescription,
  });

  const { specialistsBefore, specialistsAfter } = splitSpecialistsAroundReviewer(team);

  for (const specialist of specialistsBefore) {
    const name = specialistDisplayName(specialist.name);
    beats.push({
      id: `specialist-${specialist.id}`,
      kind: "specialist",
      status: "pending",
      title: name,
      subtitle: specialist.roleTitle,
      narrative: specialistNarrative(specialist),
      avatarSeed: specialist.avatarSeed,
      specialistId: specialist.id,
    });
  }

  if (team?.reviewer) {
    beats.push({
      id: "approval",
      kind: "approval",
      status: "pending",
      title: "You",
      subtitle: team.reviewer.roleTitle,
      narrative: team.reviewer.description || "Reviews sensitive actions before they run.",
    });
  }

  for (const specialist of specialistsAfter) {
    const name = specialistDisplayName(specialist.name);
    beats.push({
      id: `specialist-${specialist.id}`,
      kind: "specialist",
      status: "pending",
      title: name,
      subtitle: specialist.roleTitle,
      narrative: specialistNarrative(specialist),
      avatarSeed: specialist.avatarSeed,
      specialistId: specialist.id,
    });
  }

  if (!team?.specialists.length && scenario?.label) {
    beats.push({
      id: "specialist-fallback",
      kind: "specialist",
      status: "pending",
      title: "Tallei",
      subtitle: "Automation",
      narrative: scenario.label,
      avatarSeed: "test-run-fallback",
    });
  }

  const lastDestination = team?.specialists
    .flatMap((specialist) => specialist.steps)
    .findLast((step) => step.role === "destination");
  const previewResult = lastDestination?.description
    ?? specialistsAfter.at(-1)?.ownershipSummary
    ?? specialistsBefore.at(-1)?.ownershipSummary
    ?? "Automation completes successfully.";

  beats.push({
    id: "result",
    kind: "result",
    status: "pending",
    title: "Delivered",
    subtitle: "Result",
    narrative: previewResult,
  });

  return beats;
}

function findSpecialistBeatIndex(beats: TestRunStoryBeat[], specialistId?: string): number {
  if (!specialistId) return beats.findIndex((beat) => beat.kind === "specialist");
  return beats.findIndex((beat) => beat.specialistId === specialistId);
}

export function collectTestRunErrors(output: TestRunOutput): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];

  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    errors.push(trimmed);
  };

  push(output.error);
  for (const step of output.steps ?? []) {
    if (step.kind !== "error") continue;
    if (step.code && step.message) {
      push(`${step.code}: ${step.message}`);
    } else {
      push(step.message);
      push(step.code);
    }
  }
  if (output.ok === false) {
    push(output.preview);
  }

  return errors;
}

function attachErrors(beat: TestRunStoryBeat, errors: string[]): TestRunStoryBeat {
  if (errors.length === 0) return beat;
  return { ...beat, errors };
}

function applyOutputStatuses(
  beats: TestRunStoryBeat[],
  output: TestRunOutput | null | undefined,
): TestRunStoryBeat[] {
  if (!output) return beats;

  const next = beats.map((beat) => ({ ...beat }));
  const steps = output.steps ?? [];
  const errorStep = steps.find((step) => step.kind === "error");
  const toolStep = steps.find((step) => step.kind === "tool");
  const planStep = steps.find((step) => step.kind === "plan");

  if (output.ok) {
    for (let index = 0; index < next.length; index += 1) {
      const beat = next[index];
      if (!beat) continue;
      if (beat.kind === "approval") {
        beat.status = "completed";
        beat.narrative = "Approved automatically for this test run.";
      } else if (beat.kind === "result") {
        beat.status = "completed";
        if (output.preview?.trim()) {
          beat.narrative = output.preview.trim();
        }
      } else {
        beat.status = "completed";
      }
    }

    if (toolStep) {
      const specialistIndex = findSpecialistBeatIndex(next, toolStep.toolId);
      if (specialistIndex >= 0 && toolStep.args) {
        next[specialistIndex] = { ...next[specialistIndex], artifact: JSON.stringify(toolStep.args, null, 2) };
      }
    }

    return next;
  }

  if (output.ok === false) {
    const allErrors = collectTestRunErrors(output);
    let failedIndex = next.findIndex((beat) => beat.status === "active");

    if (failedIndex < 0) {
      if (toolStep) {
        failedIndex = findSpecialistBeatIndex(next, toolStep.toolId);
      } else if (output.preview?.trim() || errorStep) {
        failedIndex = next.findIndex((beat) => beat.kind === "result");
      } else if (planStep) {
        failedIndex = next.findIndex((beat) => beat.kind === "specialist");
      } else if (errorStep) {
        failedIndex = next.findIndex((beat) => beat.kind !== "trigger");
      }
    }
    if (failedIndex < 0) failedIndex = next.length - 1;

    const primaryError = allErrors[0] ?? output.error ?? errorStep?.message ?? "Test run failed.";

    for (let index = 0; index < next.length; index += 1) {
      const beat = next[index];
      if (!beat) continue;
      if (index < failedIndex) {
        beat.status = "completed";
      } else if (index === failedIndex) {
        beat.status = "failed";
        beat.narrative = allErrors.length > 1 ? primaryError : (allErrors[0] ?? primaryError);
        next[index] = attachErrors(beat, allErrors);
      } else {
        beat.status = "skipped";
      }
    }
  }

  return next;
}

export function applyPlaybackIndex(
  beats: TestRunStoryBeat[],
  activeBeatIndex: number,
  approvalApproved: boolean,
): TestRunStoryBeat[] {
  return beats.map((beat, index) => {
    if (index < activeBeatIndex) {
      if (beat.kind === "approval") {
        return {
          ...beat,
          status: "completed",
          narrative: approvalApproved
            ? "Approved automatically for this test run."
            : beat.narrative,
        };
      }
      return { ...beat, status: "completed" as const };
    }
    if (index === activeBeatIndex) {
      if (beat.kind === "approval" && approvalApproved) {
        return {
          ...beat,
          status: "completed",
          narrative: "Approved automatically for this test run.",
        };
      }
      return { ...beat, status: "active" as const };
    }
    return { ...beat, status: "pending" as const };
  });
}

export function buildTestRunStoryboardViewModel(input: {
  team?: PresentAgentTeamOutput | null;
  scenario?: TestRunScenarioInput;
  output?: unknown;
  activeBeatIndex?: number;
  approvalApproved?: boolean;
  resolvedFromOutput?: boolean;
}): TestRunStoryboardViewModel {
  const output = input.output && typeof input.output === "object"
    ? input.output as TestRunOutput
    : null;
  const team = input.team;
  const title = team?.title?.trim() || input.scenario?.label || "Test run";
  let beats = buildBaseBeats({ team, scenario: input.scenario });

  if (input.resolvedFromOutput && output) {
    beats = applyOutputStatuses(beats, output);
  } else if (input.activeBeatIndex != null) {
    beats = applyPlaybackIndex(
      beats,
      input.activeBeatIndex,
      input.approvalApproved ?? false,
    );
  }

  beats = buildBeatStepData(beats, { team, scenario: input.scenario, output });

  let footer: TestRunStoryboardViewModel["footer"] = null;
  let errorMessage: string | undefined;
  let errors: string[] | undefined;

  if (output?.ok) {
    footer = "passed";
  } else if (output?.ok === false) {
    footer = "failed";
    errors = collectTestRunErrors(output);
    errorMessage = errors[0] ?? output.error;
  } else if (input.activeBeatIndex != null || input.resolvedFromOutput === false) {
    footer = "running";
  }

  return {
    title,
    beats,
    footer,
    ...(errorMessage ? { errorMessage } : {}),
    ...(errors?.length ? { errors } : {}),
  };
}
