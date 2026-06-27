import {
  createEmptyLoopSpec,
  loopSpecSchema,
  type LoopSpec,
  type SpecPatch,
} from "./spec.js";

export function applySpecPatch(current: LoopSpec, patch: SpecPatch): LoopSpec {
  const merged: LoopSpec = {
    ...current,
    intent: patch.intent ? { ...current.intent, ...patch.intent } : current.intent,
    trigger: patch.trigger ?? current.trigger,
    profile: patch.profile ?? current.profile,
    bindings: patch.bindings ?? current.bindings,
    taskBlueprint: patch.taskBlueprint ?? current.taskBlueprint,
    agent: patch.agent
      ? { ...(current.agent ?? { instructions: "", maxSteps: 12, maxTokens: 8_000 }), ...patch.agent }
      : current.agent,
    monitor: patch.monitor ?? current.monitor,
    sync: patch.sync ?? current.sync,
    output: patch.output ? { ...current.output, ...patch.output } : current.output,
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
  if (spec.trigger.kind === "event" && !spec.trigger.composioSlug.trim()) missing.push("trigger.composioSlug");
  if (spec.trigger.kind === "event" && !spec.trigger.source.trim()) missing.push("trigger.source");
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
        approval: { mode: "ask", sensitiveCapabilities: ["email.send"] },
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
        approval: { mode: "ask", sensitiveCapabilities: ["support.reply.send"] },
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
