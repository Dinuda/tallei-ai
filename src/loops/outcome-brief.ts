import { createHash } from "node:crypto";

import type { LoopSpec } from "./spec.js";
import type { OutcomeBriefUserSummary } from "./outcome-brief-summary.js";

export type { OutcomeBriefUserSummary };

export type OutcomeBrief = {
  outcome: string;
  successCriteria: string[];
  trigger: string;
  actions: string[];
  connectors: Array<{ outcomeId: string; role: string; description: string; connector: string }>;
  output: string;
  approvals: string;
  guardrails: string[];
  assumptions: string[];
  /** Plain-language summary for the confirmation UI — generated server-side, not config-mapped. */
  userSummary?: OutcomeBriefUserSummary;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function describeTrigger(spec: LoopSpec): string {
  if (spec.trigger.kind === "manual") return "Manual";
  if (spec.trigger.kind === "schedule") {
    return `Schedule ${spec.trigger.cron} (${spec.trigger.timezone})`;
  }
  return `${spec.trigger.source}: ${spec.trigger.composioSlug || spec.trigger.eventType || "event"}`;
}

export function buildOutcomeBrief(spec: LoopSpec): OutcomeBrief {
  return {
    outcome: spec.intent.outcome,
    successCriteria: spec.intent.successCriteria,
    trigger: describeTrigger(spec),
    actions: spec.bindings.map((binding) =>
      `${binding.role ?? "action"}: ${binding.connector}/${binding.actionSlug ?? binding.capability}`,
    ),
    connectors: (spec.taskBlueprint?.outcomes ?? [])
      .filter((outcome) => outcome.role !== "transform" && Boolean(outcome.selectedConnector))
      .map((outcome) => ({
        outcomeId: outcome.id,
        role: outcome.role,
        description: outcome.description,
        connector: outcome.selectedConnector!,
      })),
    output: [spec.output.kind, spec.output.target, spec.output.connector].filter(Boolean).join(": "),
    approvals: `${spec.approval.mode}; sensitive: ${spec.approval.sensitiveCapabilities.join(", ") || "none"}`,
    guardrails: [
      `Maximum run: ${spec.guardrails.maxRunDurationMinutes} minutes`,
      `Retries per step: ${spec.guardrails.maxRetriesPerStep}`,
      ...(spec.guardrails.deniedTools.length ? [`Denied tools: ${spec.guardrails.deniedTools.join(", ")}`] : []),
    ],
    assumptions: spec.intentDiscovery.assumptions,
  };
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
