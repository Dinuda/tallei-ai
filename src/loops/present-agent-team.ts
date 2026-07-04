import { createHash } from "node:crypto";
import { z } from "zod";

import { approvalNeedsReviewForRole } from "./approval-policy.js";
import { outcomeRoleSchema, type LoopSpec, type OutcomeRole } from "./spec.js";

export const presentAgentTeamGroupSchema = z.object({
  outcomeIds: z.array(z.string().min(1)).min(1),
  roleTitle: z.string().min(1).optional(),
  ownershipSummary: z.string().min(1).optional(),
});

export const presentAgentTeamInputSchema = z.object({
  groups: z.array(presentAgentTeamGroupSchema).min(1),
  /** 0-based index among specialist groups where the user reviewer row should render. */
  reviewerBeforeSpecialistIndex: z.number().int().min(0).optional(),
});

export const agentTeamSpecialistStepSchema = z.object({
  outcomeId: z.string().min(1),
  role: outcomeRoleSchema,
  description: z.string().min(1),
  connector: z.string().optional(),
});

export const agentTeamSpecialistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  roleTitle: z.string().min(1),
  description: z.string().min(1),
  avatarSeed: z.string().min(1),
  ownershipSummary: z.string().min(1),
  steps: z.array(agentTeamSpecialistStepSchema).min(1),
});

export const agentTeamReviewerSchema = z.object({
  roleTitle: z.string().min(1),
  description: z.string().min(1),
});

export const agentTeamTriggerSchema = z.object({
  outcomeId: z.string().min(1),
  description: z.string().min(1),
  connector: z.string().optional(),
});

export const presentAgentTeamOutputSchema = z.object({
  title: z.string().min(1),
  triggers: z.array(agentTeamTriggerSchema).optional(),
  specialists: z.array(agentTeamSpecialistSchema).min(1),
  reviewer: agentTeamReviewerSchema.optional(),
  /** Index among specialist groups where the reviewer row should render (derived from approval policy). */
  reviewerInsertIndex: z.number().int().min(0).optional(),
  fallbackApplied: z.boolean().optional(),
});

export type PresentAgentTeamInput = z.infer<typeof presentAgentTeamInputSchema>;
export type PresentAgentTeamOutput = z.infer<typeof presentAgentTeamOutputSchema>;
export type AgentTeamSpecialist = z.infer<typeof agentTeamSpecialistSchema>;

const FIRST_NAMES = [
  "Alex", "Morgan", "Riley", "Casey", "Quinn", "Avery", "Reese", "Dakota",
  "Sage", "Harper", "Finley", "Emery", "Blair", "Noah", "Luna", "Milo",
  "Zara", "Kai", "Ivy", "Theo", "Nora", "Ezra", "Cleo", "Jules", "Remy",
  "Arlo", "Mira", "Ellis", "Juno", "Levi", "Vera", "Owen", "Ada", "Nico",
  "Sloane", "Marlow", "Indie", "Romy", "Kiran", "Amari", "Devon", "Shay",
  "Tatum", "Wren", "Palmer", "Reign", "Sutton", "Landry", "Oakley", "Bellamy",
];

function firstNameOnly(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim() || "Alex";
}

function hashSeed(input: string): number {
  const digest = createHash("sha256").update(input).digest();
  return digest.readUInt32BE(0);
}

function assignUniqueFirstNames(seeds: string[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();

  const ranked = seeds
    .map((seed, order) => ({ seed, order, hash: hashSeed(`${seed}:${order}`) }))
    .sort((left, right) => left.hash - right.hash);

  for (const entry of ranked) {
    const start = entry.hash % FIRST_NAMES.length;
    let assigned: string | undefined;
    for (let attempt = 0; attempt < FIRST_NAMES.length; attempt += 1) {
      const candidate = FIRST_NAMES[(start + attempt) % FIRST_NAMES.length] ?? "Alex";
      if (!used.has(candidate)) {
        assigned = candidate;
        break;
      }
    }
    const name = assigned ?? `Agent ${names.size + 1}`;
    used.add(name);
    names.set(entry.seed, name);
  }

  return names;
}

function humanizeConnector(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function deriveJobRoleTitle(
  steps: Array<{ role: string; description: string }>,
): string {
  const roles = steps.map((step) => step.role);
  const roleSet = new Set(roles);

  if (roleSet.has("source") && roleSet.has("transform") && roleSet.has("destination")) {
    return "Operations Lead";
  }
  if (roleSet.has("source") && roleSet.has("transform")) {
    return "Business Analyst";
  }
  if (roleSet.has("transform") && roleSet.has("destination")) {
    return "Fulfillment Analyst";
  }
  if (roleSet.has("source") && roleSet.has("destination")) {
    return "Operations Coordinator";
  }

  const onlyRole = roles.length === 1 ? roles[0] : undefined;
  if (onlyRole === "source") return "Research Analyst";
  if (onlyRole === "transform") return "Operations Analyst";
  if (onlyRole === "destination") return "Delivery Coordinator";
  if (onlyRole === "trigger") return "Automation Lead";

  return "Workflow Analyst";
}

function deriveOwnershipSummary(
  steps: Array<{ role: string; description: string; connector?: string }>,
  suggested?: string,
): string {
  if (suggested?.trim()) return suggested.trim();
  if (steps.length === 1) return steps[0]!.description;
  const verbs = steps.map((step) => step.description.split(/\s+/)[0]?.toLowerCase()).filter(Boolean);
  if (verbs.length >= 2) {
    return `${verbs[0]} → ${verbs.slice(1).join(" → ")}`;
  }
  return steps.map((step) => step.description).join("; ");
}

function deriveDescription(
  steps: Array<{ role: string; description: string; connector?: string }>,
  roleTitle: string,
): string {
  const connectors = [...new Set(steps.map((step) => step.connector).filter(Boolean))];
  const connectorNote = connectors.length
    ? ` via ${connectors.map((connector) => humanizeConnector(connector!)).join(" and ")}`
    : "";
  if (steps.length === 1) {
    return `Owns ${steps[0]!.description.toLowerCase()}${connectorNote}.`;
  }
  return `${roleTitle} covering ${steps.length} connected workflow steps${connectorNote}.`;
}

function avatarSeedForGroup(outcomeIds: string[]): string {
  return createHash("sha256").update(outcomeIds.join(":")).digest("hex").slice(0, 16);
}

function specialistIdForGroup(outcomeIds: string[]): string {
  return createHash("sha256").update(`specialist:${outcomeIds.join(":")}`).digest("hex").slice(0, 12);
}

type BlueprintOutcome = {
  id: string;
  role: string;
  description: string;
  selectedConnector?: string;
};

function readBlueprintOutcomes(spec: LoopSpec): BlueprintOutcome[] {
  return (spec.taskBlueprint?.outcomes ?? []).map((outcome) => ({
    id: outcome.id,
    role: outcome.role,
    description: outcome.description,
    selectedConnector: outcome.selectedConnector,
  }));
}

function readNonTriggerOutcomeIds(
  orderedOutcomeIds: string[],
  outcomesById: Map<string, BlueprintOutcome>,
): string[] {
  return orderedOutcomeIds.filter((outcomeId) => outcomesById.get(outcomeId)?.role !== "trigger");
}

function approvalSplitIndex(
  outcomes: BlueprintOutcome[],
  spec: LoopSpec,
): number | null {
  if (spec.approval.mode === "auto") return null;
  if (spec.approval.mode === "ask") return 0;

  const nonTrigger = outcomes.filter((outcome) => outcome.role !== "trigger");
  const index = nonTrigger.findIndex((outcome) =>
    approvalNeedsReviewForRole(spec.approval, outcome.role as OutcomeRole),
  );
  return index >= 0 ? index : null;
}

function groupCrossesApprovalBoundary(
  groupOutcomeIds: string[],
  nonTriggerOutcomeIds: string[],
  splitIndex: number | null,
  outcomesById: Map<string, BlueprintOutcome>,
): boolean {
  if (splitIndex === null) return false;

  const specialistIds = groupOutcomeIds.filter(
    (outcomeId) => outcomesById.get(outcomeId)?.role !== "trigger",
  );
  if (specialistIds.length <= 1) return false;

  let hasBefore = false;
  let hasAtOrAfter = false;
  for (const outcomeId of specialistIds) {
    const index = nonTriggerOutcomeIds.indexOf(outcomeId);
    if (index < 0) continue;
    if (index < splitIndex) hasBefore = true;
    else hasAtOrAfter = true;
  }

  return hasBefore && hasAtOrAfter;
}

function isValidGrouping(
  orderedOutcomeIds: string[],
  groups: Array<{ outcomeIds: string[] }>,
  outcomesById: Map<string, BlueprintOutcome>,
  splitIndex: number | null,
): boolean {
  const outcomeSet = new Set(orderedOutcomeIds);
  const seen = new Set<string>();
  const nonTriggerOutcomeIds = readNonTriggerOutcomeIds(orderedOutcomeIds, outcomesById);
  let cursor = 0;

  for (const group of groups) {
    if (group.outcomeIds.length === 0) return false;
    if (groupCrossesApprovalBoundary(group.outcomeIds, nonTriggerOutcomeIds, splitIndex, outcomesById)) {
      return false;
    }
    for (const outcomeId of group.outcomeIds) {
      if (!outcomeSet.has(outcomeId) || seen.has(outcomeId)) return false;
      if (orderedOutcomeIds[cursor] !== outcomeId) return false;
      seen.add(outcomeId);
      cursor += 1;
    }
  }

  return seen.size === orderedOutcomeIds.length;
}

function buildSpecialist(
  outcomeIds: string[],
  outcomesById: Map<string, BlueprintOutcome>,
  nameBySeed: Map<string, string>,
  group?: { roleTitle?: string; ownershipSummary?: string },
): AgentTeamSpecialist {
  const steps = outcomeIds.map((outcomeId) => {
    const outcome = outcomesById.get(outcomeId)!;
    return {
      outcomeId,
      role: outcome.role as z.infer<typeof outcomeRoleSchema>,
      description: outcome.description,
      ...(outcome.selectedConnector ? { connector: outcome.selectedConnector } : {}),
    };
  });
  const roleTitle = deriveJobRoleTitle(steps);
  const avatarSeed = avatarSeedForGroup(outcomeIds);
  const name = firstNameOnly(nameBySeed.get(avatarSeed) ?? "Alex");
  return {
    id: specialistIdForGroup(outcomeIds),
    name,
    roleTitle,
    description: deriveDescription(steps, roleTitle),
    avatarSeed,
    ownershipSummary: deriveOwnershipSummary(steps, group?.ownershipSummary),
    steps,
  };
}

function extractTriggers(
  groups: Array<{ outcomeIds: string[]; roleTitle?: string; ownershipSummary?: string }>,
  outcomesById: Map<string, BlueprintOutcome>,
): {
  triggers: z.infer<typeof agentTeamTriggerSchema>[];
  specialistGroups: Array<{ outcomeIds: string[]; roleTitle?: string; ownershipSummary?: string }>;
} {
  const triggers: z.infer<typeof agentTeamTriggerSchema>[] = [];
  const specialistGroups: Array<{ outcomeIds: string[]; roleTitle?: string; ownershipSummary?: string }> = [];

  for (const group of groups) {
    const specialistOutcomeIds: string[] = [];

    for (const outcomeId of group.outcomeIds) {
      const outcome = outcomesById.get(outcomeId);
      if (!outcome) continue;
      if (outcome.role === "trigger") {
        triggers.push({
          outcomeId,
          description: outcome.description,
          ...(outcome.selectedConnector ? { connector: outcome.selectedConnector } : {}),
        });
      } else {
        specialistOutcomeIds.push(outcomeId);
      }
    }

    if (specialistOutcomeIds.length > 0) {
      specialistGroups.push({
        ...group,
        outcomeIds: specialistOutcomeIds,
      });
    }
  }

  return { triggers, specialistGroups };
}

function fallbackGroups(outcomes: BlueprintOutcome[]): Array<{ outcomeIds: string[] }> {
  return outcomes.map((outcome) => ({ outcomeIds: [outcome.id] }));
}

function deriveReviewerInsertIndex(
  spec: LoopSpec,
  specialistGroups: Array<{ outcomeIds: string[] }>,
  orderedOutcomeIds: string[],
  outcomesById: Map<string, BlueprintOutcome>,
): number {
  const splitIndex = approvalSplitIndex(
    orderedOutcomeIds
      .map((outcomeId) => outcomesById.get(outcomeId))
      .filter((outcome): outcome is BlueprintOutcome => Boolean(outcome)),
    spec,
  );
  if (splitIndex === null) return specialistGroups.length;

  const nonTriggerOutcomeIds = readNonTriggerOutcomeIds(orderedOutcomeIds, outcomesById);
  let insertAt = 0;
  for (const group of specialistGroups) {
    const specialistIds = group.outcomeIds.filter(
      (outcomeId) => outcomesById.get(outcomeId)?.role !== "trigger",
    );
    if (specialistIds.length === 0) continue;
    const maxIndex = Math.max(...specialistIds.map((outcomeId) => nonTriggerOutcomeIds.indexOf(outcomeId)));
    if (maxIndex < splitIndex) {
      insertAt += 1;
    } else {
      break;
    }
  }
  return insertAt;
}

function resolveTitle(spec: LoopSpec): string {
  const blueprintSummary = spec.taskBlueprint?.summary?.trim();
  const outcome = spec.intent.outcome?.trim();
  const goal = spec.intent.goal?.trim();
  return blueprintSummary || outcome || goal || "Automation team";
}

function resolveReviewer(spec: LoopSpec): z.infer<typeof agentTeamReviewerSchema> | undefined {
  if (spec.approval.mode === "auto") return undefined;
  if (spec.approval.mode === "ask") {
    return {
      roleTitle: "Reviewer",
      description: "Reviews every action before it runs.",
    };
  }
  return {
    roleTitle: "Reviewer",
    description: "Reviews sensitive actions before they run.",
  };
}

export function normalizeAgentTeam(
  input: PresentAgentTeamInput,
  spec: LoopSpec,
): PresentAgentTeamOutput {
  const outcomes = readBlueprintOutcomes(spec);
  const orderedOutcomeIds = outcomes.map((outcome) => outcome.id);
  const outcomesById = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const splitIndex = approvalSplitIndex(outcomes, spec);

  const valid = orderedOutcomeIds.length > 0
    && isValidGrouping(orderedOutcomeIds, input.groups, outcomesById, splitIndex);

  const groups = valid
    ? input.groups
    : fallbackGroups(outcomes);

  const { triggers, specialistGroups } = extractTriggers(groups, outcomesById);
  const avatarSeeds = specialistGroups.map((group) => avatarSeedForGroup(group.outcomeIds));
  const nameBySeed = assignUniqueFirstNames(avatarSeeds);
  const specialists = specialistGroups
    .map((group) => buildSpecialist(group.outcomeIds, outcomesById, nameBySeed, group))
    .filter((specialist) => specialist.steps.length > 0);
  const reviewer = resolveReviewer(spec);

  return {
    title: resolveTitle(spec),
    ...(triggers.length > 0 ? { triggers } : {}),
    specialists,
    reviewer,
    reviewerInsertIndex: reviewer
      ? deriveReviewerInsertIndex(spec, specialistGroups, orderedOutcomeIds, outcomesById)
      : undefined,
    ...(valid ? {} : { fallbackApplied: true }),
  };
}
