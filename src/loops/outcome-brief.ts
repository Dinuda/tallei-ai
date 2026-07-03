import { createHash } from "node:crypto";

import type { LoopSpec } from "./spec.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function computeOutcomeBriefHash(spec: LoopSpec): string {
  const material = {
    intent: spec.intent,
    trigger: spec.trigger,
    taskBlueprint: spec.taskBlueprint,
    bindings: spec.bindings,
    composioActions: spec.composioActions,
    output: spec.output,
    approval: spec.approval,
    guardrails: spec.guardrails,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(material)))
    .digest("hex");
}

export function isOutcomeBriefConfirmed(spec: LoopSpec): boolean {
  return spec.intentDiscovery.status === "confirmed"
    && spec.intentDiscovery.confirmedBriefHash === computeOutcomeBriefHash(spec);
}

function reviewMaterial(spec: LoopSpec) {
  return {
    intent: {
      goal: spec.intent.goal,
      outcome: spec.intent.outcome,
      successCriteria: spec.intent.successCriteria,
    },
    outcomes: (spec.taskBlueprint?.outcomes ?? []).map((outcome) => ({
      id: outcome.id,
      role: outcome.role,
      description: outcome.description,
      selectedConnector: outcome.selectedConnector,
    })),
    trigger: spec.trigger.kind === "event"
      ? { kind: spec.trigger.kind, source: spec.trigger.source }
      : spec.trigger.kind === "schedule"
        ? { kind: spec.trigger.kind, cron: spec.trigger.cron, timezone: spec.trigger.timezone }
        : { kind: spec.trigger.kind },
    bindings: spec.bindings.map((binding) => ({
      capability: binding.capability,
      connector: binding.connector,
      role: binding.role,
    })),
    output: spec.output,
    approval: {
      mode: spec.approval.mode,
      sensitiveRoles: spec.approval.sensitiveRoles,
      sensitiveCapabilities: spec.approval.sensitiveCapabilities,
    },
  };
}

/** Fingerprint of user-visible review content (excludes technical slugs and schemas). */
export function computeOutcomeReviewFingerprint(spec: LoopSpec): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(reviewMaterial(spec))))
    .digest("hex");
}

export function isUserVisibleReviewUnchanged(before: LoopSpec, after: LoopSpec): boolean {
  return computeOutcomeReviewFingerprint(before) === computeOutcomeReviewFingerprint(after);
}
