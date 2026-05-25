import type {
  CandidateLoop,
  EpisodeRecord,
  LoopEvaluation,
  LoopImplementabilityAssessment,
} from "./types.js";

export interface QualifiedLoopInput {
  candidateLoop: CandidateLoop;
  evaluation: LoopEvaluation;
  episodes: EpisodeRecord[];
}

export interface QualifiedLoopWithImplementability extends QualifiedLoopInput {
  implementability: LoopImplementabilityAssessment;
}

const DELIVERY_CAPABILITIES = ["notification:whatsapp", "notification:email", "resend", "gmail"];

function normalizeCapability(value: string): string {
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (key === "googlecalendar") return "googlecalendar";
  return key;
}

function normalizeCapabilities(capabilities: string[]): Set<string> {
  return new Set(capabilities.map(normalizeCapability).filter(Boolean));
}

function joinedSignalText(input: QualifiedLoopInput): string {
  const parts: string[] = [
    input.candidateLoop.loopName,
    input.candidateLoop.sharedIntent,
    input.candidateLoop.sharedOutputType,
    ...input.candidateLoop.sharedSources,
    input.evaluation.reasoning,
    ...input.evaluation.risks,
  ];
  for (const episode of input.episodes) {
    parts.push(
      episode.intent,
      episode.outputType,
      ...episode.sources,
      ...episode.toolNames,
      ...episode.steps,
      ...(episode.upstreamWork?.steps ?? []),
      ...(episode.upstreamWork?.inputSources.map((source) => source.name) ?? [])
    );
  }
  return parts.join("\n").toLowerCase();
}

function hasAnyCapability(capabilities: Set<string>, expected: string[]): boolean {
  return expected.some((value) => capabilities.has(normalizeCapability(value)));
}

function inferRequiredCapabilities(input: QualifiedLoopInput, signalText: string): string[] {
  const required = new Set<string>();
  if (/\b(github|gitlab|bitbucket|pull request|commit|repository|repo)\b/.test(signalText)) required.add("github");
  if (/\b(slack)\b/.test(signalText)) required.add("slack");
  if (/\b(notion)\b/.test(signalText)) required.add("notion");
  if (/\b(linear)\b/.test(signalText)) required.add("linear");
  if (/\b(calendar|meeting scheduling|schedule meeting)\b/.test(signalText)) required.add("googlecalendar");

  if (/\bresend\b/.test(signalText)) required.add("resend");
  if (/\bgmail\b/.test(signalText)) required.add("gmail");

  const outputType = input.candidateLoop.sharedOutputType.toLowerCase();
  const isNewsletterOrEmail = outputType.includes("newsletter") || outputType.includes("email")
    || /\b(newsletter|email)\b/.test(signalText);
  const hasDeliveryAction = /\b(send|sending|deliver|delivery|distribute|publish|broadcast)\b/.test(signalText);
  if (isNewsletterOrEmail && hasDeliveryAction) required.add("delivery");

  return [...required];
}

function deriveBlockers(input: QualifiedLoopInput, signalText: string): string[] {
  const blockers: string[] = [];
  if (input.evaluation.automationReadiness === "manual") {
    blockers.push("automation_readiness_manual");
  }

  const combinedRisk = `${input.evaluation.reasoning}\n${input.evaluation.risks.join("\n")}`.toLowerCase();
  if (/\b(one[- ]off|ad hoc|unique case|single occurrence|requires offline coordination|requires stakeholder interviews)\b/.test(combinedRisk)) {
    blockers.push("one_off_or_human_continuity");
  }
  if (/\b(heavy human judgment|requires human judgment|subjective decision|legal review|compliance approval)\b/.test(combinedRisk)) {
    blockers.push("high_human_judgment");
  }

  // Secondary guard when evaluator wording is weak but episode evidence is clearly one-off.
  if (blockers.length === 0 && /\b(one[- ]time|one time|single launch|single migration)\b/.test(signalText)) {
    blockers.push("likely_one_off");
  }

  return blockers;
}

function computeAssessment(input: QualifiedLoopInput, capabilities: Set<string>): LoopImplementabilityAssessment {
  const signalText = joinedSignalText(input);
  const required = inferRequiredCapabilities(input, signalText);
  const blockers = deriveBlockers(input, signalText);

  const missingCapabilities: string[] = [];
  const matchedCapabilities: string[] = [];

  for (const requirement of required) {
    if (requirement === "delivery") {
      if (hasAnyCapability(capabilities, DELIVERY_CAPABILITIES)) {
        matchedCapabilities.push("delivery");
      } else {
        missingCapabilities.push("delivery");
      }
      continue;
    }
    if (hasAnyCapability(capabilities, [requirement])) {
      matchedCapabilities.push(requirement);
    } else {
      missingCapabilities.push(requirement);
    }
  }

  const implementable = blockers.length === 0 && missingCapabilities.length === 0;
  const rationale = implementable
    ? "Loop has no hard blockers and required capabilities are available."
    : "Loop is blocked by missing capabilities and/or high human continuity requirements.";

  return {
    status: implementable ? "implementable" : "not_implementable",
    matchedCapabilities,
    missingCapabilities,
    blockers,
    rationale,
  };
}

export class LoopImplementabilityFilterUseCase {
  execute(input: {
    qualifiedLoops: QualifiedLoopInput[];
    activeCapabilities: string[];
  }): {
    implementable: QualifiedLoopWithImplementability[];
    blocked: QualifiedLoopWithImplementability[];
  } {
    const capabilities = normalizeCapabilities(input.activeCapabilities);
    const implementable: QualifiedLoopWithImplementability[] = [];
    const blocked: QualifiedLoopWithImplementability[] = [];

    for (const loop of input.qualifiedLoops) {
      const implementability = computeAssessment(loop, capabilities);
      const row = { ...loop, implementability };
      if (implementability.status === "implementable") {
        implementable.push(row);
      } else {
        blocked.push(row);
      }
    }

    return { implementable, blocked };
  }
}
