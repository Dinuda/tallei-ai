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
