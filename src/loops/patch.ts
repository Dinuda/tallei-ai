import {
  createEmptyLoopSpec,
  loopSpecSchema,
  type LoopSpec,
  type SpecPatch,
} from "./spec.js";
import { isEventTriggerReadyForCompile } from "./event-trigger.js";
import { normalizeTaskBlueprint } from "./task-decomposition.js";

function resolveExecutionOrder(current: LoopSpec, patch: SpecPatch) {
  return patch.intentDiscovery?.analysis?.executionOrder
    ?? current.intentDiscovery.analysis?.executionOrder
    ?? [];
}

export function applySpecPatch(current: LoopSpec, patch: SpecPatch): LoopSpec {
  const executionOrder = resolveExecutionOrder(current, patch);
  const nextBlueprint = patch.taskBlueprint
    ? normalizeTaskBlueprint(patch.taskBlueprint, executionOrder)
    : current.taskBlueprint;
  const intentChanged = patch.intent !== undefined
    && JSON.stringify({ ...current.intent, ...patch.intent }) !== JSON.stringify(current.intent);
  const currentOutcomes = new Map((current.taskBlueprint?.outcomes ?? []).map((outcome) => [outcome.id, outcome]));
  const changedConnectorRoles = new Set<string>();
  const changedConnectorSlugs = new Set<string>();
  if (patch.taskBlueprint) {
    for (const outcome of nextBlueprint?.outcomes ?? []) {
      const previous = currentOutcomes.get(outcome.id);
      if (previous?.selectedConnector === outcome.selectedConnector) continue;
      changedConnectorRoles.add(outcome.role);
      if (previous?.selectedConnector) changedConnectorSlugs.add(previous.selectedConnector.toLowerCase());
      if (outcome.selectedConnector) changedConnectorSlugs.add(outcome.selectedConnector.toLowerCase());
    }
  }

  const clearAllGenerated = intentChanged;
  const clearGeneratedForConnector = changedConnectorRoles.size > 0;
  const retainedBindings = clearAllGenerated
    ? []
    : clearGeneratedForConnector
      ? current.bindings.filter((binding) =>
          !changedConnectorRoles.has(binding.role ?? "")
          && !changedConnectorSlugs.has(binding.connector.toLowerCase()),
        )
      : current.bindings;
  const retainedComposioActions = clearAllGenerated
    ? []
    : clearGeneratedForConnector
      ? current.composioActions.filter((action) => !changedConnectorSlugs.has(action.toolkit.toLowerCase()))
      : current.composioActions;
  const materialPatch = patch.intent !== undefined
    || patch.trigger !== undefined
    || patch.taskBlueprint !== undefined
    || patch.bindings !== undefined
    || patch.composioActions !== undefined
    || patch.output !== undefined
    || patch.approval !== undefined
    || patch.guardrails !== undefined;
  const mergedIntentDiscovery = patch.intentDiscovery
    ? { ...current.intentDiscovery, ...patch.intentDiscovery }
    : current.intentDiscovery;

  const merged: LoopSpec = {
    ...current,
    intent: patch.intent ? { ...current.intent, ...patch.intent } : current.intent,
    trigger: patch.trigger
      ?? (clearAllGenerated || changedConnectorRoles.has("trigger") ? { kind: "manual" as const } : current.trigger),
    profile: patch.profile ?? current.profile,
    bindings: patch.bindings ?? retainedBindings,
    composioActions: patch.composioActions ?? retainedComposioActions,
    taskBlueprint: nextBlueprint,
    intentDiscovery: materialPatch
      ? {
          ...mergedIntentDiscovery,
          status: mergedIntentDiscovery.status === "confirmed" ? "ready" : mergedIntentDiscovery.status,
          confirmedBriefHash: undefined,
        }
      : mergedIntentDiscovery,
    agent: patch.agent
      ? { ...(current.agent ?? { instructions: "", maxSteps: 12, maxTokens: 8_000 }), ...patch.agent }
      : current.agent,
    monitor: patch.monitor ?? current.monitor,
    sync: patch.sync ?? current.sync,
    output: patch.output
      ? { ...current.output, ...patch.output }
      : clearAllGenerated || changedConnectorRoles.has("destination")
        ? { kind: "none" as const }
        : current.output,
    approval: patch.approval ? { ...current.approval, ...patch.approval } : current.approval,
    guardrails: patch.guardrails ? { ...current.guardrails, ...patch.guardrails } : current.guardrails,
  };
  return loopSpecSchema.parse(merged);
}

export function getMissingSlots(spec: LoopSpec): string[] {
  const missing: string[] = [];
  if (!spec.intent.goal.trim()) missing.push("intent.goal");
  if (!spec.intent.outcome.trim()) missing.push("intent.outcome");
  if (spec.trigger.kind === "schedule" && !spec.trigger.cron.trim()) missing.push("trigger.cron");
  if (spec.trigger.kind === "event") {
    if (!spec.trigger.source.trim()) missing.push("trigger.source");
    if (!isEventTriggerReadyForCompile(spec.trigger.source, spec.trigger.composioSlug)) {
      missing.push("trigger.composioSlug");
    }
  }
  if (spec.profile === "agentic" && !spec.agent?.instructions?.trim()) missing.push("agent.instructions");
  if (spec.bindings.length === 0) missing.push("bindings");
  if (spec.output.kind !== "none" && !spec.output.target?.trim()) missing.push("output.target");
  return missing;
}

export function isReadyToCompile(spec: LoopSpec): boolean {
  return getMissingSlots(spec).length === 0;
}

export function seedSpecFromTemplate(
  workspaceId: string,
  templateId: string,
): LoopSpec {
  const base = createEmptyLoopSpec(workspaceId);
  switch (templateId) {
    case "research_digest":
      return applySpecPatch(base, {
        intent: {
          goal: "Deliver a daily research digest on topics I care about",
          outcome: "Concise digest of recent findings delivered on schedule",
          successCriteria: ["Relevant sources", "Actionable summary"],
        },
        profile: "agentic",
        trigger: { kind: "schedule", cron: "0 7 * * *", timezone: "UTC" },
        output: { kind: "chat" },
      });
    case "newsletter_loop":
      return applySpecPatch(base, {
        intent: {
          goal: "Curate news and send a newsletter to subscribers",
          outcome: "Weekly newsletter with curated content",
          successCriteria: ["Quality curation", "Delivered on schedule"],
        },
        profile: "agentic",
        trigger: { kind: "schedule", cron: "0 9 * * 5", timezone: "UTC" },
        output: { kind: "email" },
        approval: { mode: "mixed", sensitiveRoles: ["destination"], sensitiveCapabilities: ["email.send"] },
      });
    case "lead_scoring":
      return applySpecPatch(base, {
        intent: {
          goal: "Score incoming leads and notify sales for hot leads",
          outcome: "Sales notified when high-value leads arrive",
          successCriteria: ["Consistent scoring", "Timely notification"],
        },
        profile: "agentic",
        trigger: { kind: "event", source: "hubspot", composioSlug: "HUBSPOT_NEW_CONTACT", eventType: "lead.created" },
        output: { kind: "chat" },
      });
    case "support_auto_reply":
      return applySpecPatch(base, {
        intent: {
          goal: "Classify support tickets and draft context-aware replies",
          outcome: "Faster ticket handling with human-approved replies",
          successCriteria: ["Accurate classification", "Safe replies"],
        },
        profile: "agentic",
        trigger: { kind: "event", source: "zendesk", composioSlug: "ZENDESK_NEW_TICKET", eventType: "ticket.created" },
        approval: { mode: "mixed", sensitiveRoles: ["destination"], sensitiveCapabilities: ["support.reply.send"] },
      });
    case "smart_alerts":
      return applySpecPatch(base, {
        intent: {
          goal: "Monitor metrics and alert when thresholds break",
          outcome: "Timely alerts to the right channel",
          successCriteria: ["No false positives", "Fast notification"],
        },
        profile: "monitor",
        monitor: {
          source: "metrics.cpu",
          rule: { op: "gt", field: "value", value: 85, windowMinutes: 5 },
          cooldownMinutes: 15,
        },
        output: { kind: "chat" },
      });
    case "crm_sync":
      return applySpecPatch(base, {
        intent: {
          goal: "Keep contacts in sync across systems",
          outcome: "Consistent contact records across CRM and docs",
          successCriteria: ["No duplicates", "Conflict resolution"],
        },
        profile: "sync",
        sync: {
          left: { connector: "notion", object: "contact" },
          right: { connector: "hubspot", object: "contact" },
          mapping: { email: "email", name: "firstname" },
          conflictPolicy: "newest_wins",
          direction: "bidirectional",
        },
      });
    default:
      return base;
  }
}
